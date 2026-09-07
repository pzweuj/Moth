import {
  acknowledgeProgress,
  clearOfflineData,
  clearOfflineContent,
  drainOfflineWrites,
  freezeOfflineStorage,
  getOfflineBook,
  getOfflineBooks,
  getOfflineSections,
  getOfflineChapter,
  getOfflinePage,
  getOfflineResource,
  hasOfflineBooks,
  isOfflineStorageFrozen,
  listPendingProgress,
  removePendingProgress,
  reconcileOfflineInstance,
  saveOfflineBookSummary,
  saveOfflineSections,
  saveOfflineCover,
  saveOfflinePage,
  saveOfflineChapter,
  saveOfflineResource,
  setOfflineScope,
  unfreezeOfflineStorage,
} from "./offline/db";

export type SetupStatus = {
  initialized: boolean;
};

export type SessionState = {
  authenticated: boolean;
  username?: string;
  offline?: boolean;
  instance_id?: string;
  account_id?: string;
};

export type BookSummary = {
  id: number;
  title: string;
  author?: string;
  format: "epub" | "txt" | "cbz" | "mobi";
  has_cover: boolean;
  cover_url?: string;
  page_count: number;
  parse_status: "ok" | "error";
  percent: number;
  content_version: string;
  file_size: number;
  /** Present for local shelf entries that have at least one cached unit. */
  cached_content?: boolean;
  section_id?: number;
  section_name?: string;
  series_id?: number;
  series_name?: string;
  series_order?: number;
  missing?: boolean;
};

export type SeriesSummary = {
  id: number;
  name: string;
  section_id: number;
  sort_order: number;
  book_count: number;
  cover_url?: string;
  books: BookSummary[];
};

export type SectionSummary = {
  id: number;
  name: string;
  sort_order: number;
  is_system: boolean;
  book_count: number;
  series: SeriesSummary[];
  books: BookSummary[];
};

export type ChapterInfo = {
  idx: number;
  title: string;
  /** Byte size of the rendered chapter content. */
  size: number;
};

export type ProgressBody = {
  chapter_index: number;
  page_index: number;
  percent: number;
  revision?: number;
  content_version?: string;
  cfi?: string;
  /** TXT positions are tied to the decoder used to build the chapters. */
  encoding?: string;
};

const offline = () => typeof navigator !== "undefined" && !navigator.onLine;
const PENDING_LOGOUT_KEY = "moth-pending-server-logout";
const LOGOUT_TIMEOUT_MS = 5000;
const API_REQUEST_TIMEOUT_MS = 15000;
let progressFlushPromise: Promise<void> | null = null;
const activeProgressControllers = new Set<AbortController>();
const progressRequestLocks = new Map<string, Promise<void>>();
let progressRequestGeneration = 0;

function setPendingLogout(): void {
  try {
    localStorage.setItem(PENDING_LOGOUT_KEY, "1");
  } catch {
    // Private browsing may disable localStorage; the local data is still cleared.
  }
}

function clearPendingLogout(): void {
  try {
    localStorage.removeItem(PENDING_LOGOUT_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }
}

function hasPendingLogout(): boolean {
  try {
    return localStorage.getItem(PENDING_LOGOUT_KEY) === "1";
  } catch {
    return false;
  }
}

function clearLocalReaderPreferences(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("moth:txt-encoding:")) localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage cleanup failures.
  }
}

export type BookDetail = BookSummary & {
  parse_error?: string;
  chapters: ChapterInfo[];
  /** Server order of CBZ entries, used to map locale-aware browser sorting. */
  pages?: string[];
  progress?: ProgressBody;
  parser_version?: string;
};

export type ChapterContent = {
  idx: number;
  title: string;
  content: string;
  encoding?: string;
  parser_version?: string;
};

export type OfflineManifest = {
  id: number;
  title: string;
  format: BookSummary["format"];
  content_version: string;
  file_size: number;
  cover_url?: string;
  file_url?: string;
  chapters: Array<{ idx: number; title: string; size: number; url: string }>;
  resource_urls: string[];
  encoding?: string;
  parser_version?: string;
};

export type ScanStatus = {
  scanning: boolean;
  processed: number;
  total: number;
  errors: number;
  message: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function requestAbortError(message: string): Error {
  return typeof DOMException !== "undefined"
    ? new DOMException(message, "AbortError")
    : new Error(message);
}

/**
 * Give server reads a finite lifetime so a self-hosted instance that vanished
 * without updating `navigator.onLine` still falls back to IndexedDB. The
 * caller's signal is forwarded and also wins the race during logout or
 * reader teardown.
 */
export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const external = init.signal;
  let onExternalAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fetchPromise = Promise.resolve().then(() => fetch(input, {
    ...init,
    signal: controller.signal,
  }));
  const timeoutPromise = new Promise<Response>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(requestAbortError("Request timed out"));
    }, API_REQUEST_TIMEOUT_MS);
  });
  const abortPromise = external
    ? new Promise<Response>((_, reject) => {
      onExternalAbort = () => {
        controller.abort();
        reject(requestAbortError("Request was cancelled"));
      };
      external.addEventListener("abort", onExternalAbort, { once: true });
      if (external.aborted) onExternalAbort();
    })
    : null;

  try {
    return await Promise.race(
      abortPromise ? [fetchPromise, abortPromise, timeoutPromise] : [fetchPromise, timeoutPromise],
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (external && onExternalAbort) external.removeEventListener("abort", onExternalAbort);
  }
}

async function request<T>(path: string, init?: RequestInit, expectedContentVersion?: string): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetchWithTimeout(`/api/v1${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  if (!response.ok) {
    let code = "request_failed";
    let message = "Something went wrong. Please try again.";
    try {
      const payload = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      code = payload.error?.code ?? code;
      message = payload.error?.message ?? message;
    } catch {
      // Keep the safe generic message when the server did not return JSON.
    }
    throw new ApiError(response.status, code, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  if (expectedContentVersion) {
    const expected = `"${expectedContentVersion}"`;
    if (response.headers.get("etag")?.trim() !== expected) {
      throw new ApiError(412, "content_changed", "The book changed while it was being read. Refresh before continuing.");
    }
  }
  return (await response.json()) as T;
}

async function clearMothCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith("moth-shell-") || key.startsWith("moth-runtime-"))
      .map((key) => caches.delete(key)));
  } catch {
    // Cache Storage is optional (private browsing and older WebViews).
  }
}

function cancelProgressRequests(): void {
  progressRequestGeneration += 1;
  for (const controller of activeProgressControllers) controller.abort();
  activeProgressControllers.clear();
}

function progressAbortError(): Error {
  return typeof DOMException !== "undefined"
    ? new DOMException("Progress sync was cancelled", "AbortError")
    : new Error("Progress sync was cancelled");
}

async function progressRequest<T>(key: string, path: string, init: RequestInit): Promise<T> {
  const generation = progressRequestGeneration;
  const previous = progressRequestLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    if (generation !== progressRequestGeneration || isOfflineStorageFrozen()) throw progressAbortError();
    const controller = new AbortController();
    activeProgressControllers.add(controller);
    try {
      return await request<T>(path, { ...init, signal: controller.signal });
    } finally {
      activeProgressControllers.delete(controller);
    }
  });
  const slot = run.then(() => undefined, () => undefined);
  progressRequestLocks.set(key, slot);
  // Do not retain a promise for every book ever opened. Keep the slot while
  // it is active so concurrent callers serialize, then remove it only when no
  // newer request has replaced it.
  void slot.then(() => {
    if (progressRequestLocks.get(key) === slot) progressRequestLocks.delete(key);
  });
  return run;
}

/** Keep local sign-out from waiting forever on a stalled server connection. */
async function tryServerLogout(): Promise<boolean> {
  if (offline()) return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const requestPromise = request<void>("/session", {
    method: "DELETE",
    signal: controller.signal,
  }).then(() => true, () => false);
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, LOGOUT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([requestPromise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isContentVersionError(error: unknown): boolean {
  return error instanceof ApiError
    && (error.status === 412 || error.code === "content_changed");
}

function mayUseCachedContent(error: unknown): boolean {
  // A cache is safe to select when the device is offline or the session has
  // expired. A transport failure can leave navigator.onLine=true (for
  // example, when the self-hosted server is down), so it must take the same
  // local path. Content precondition failures are deliberately excluded: a
  // cached unit from the old hash must never be mixed with a new book.
  return offline()
    || error instanceof TypeError
    || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
    || (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status >= 500));
}

/**
 * Chapter HTML is rendered in a sandboxed blob document. Fetch the resources
 * referenced by the server-rendered chapter here, in the parent application,
 * so the document never needs to make an authenticated network request.
 */
async function cacheChapterResources(
  id: number,
  version: string,
  content: string,
): Promise<boolean> {
  const pattern = new RegExp(`/api/v1/books/${id}/resource/(\\d+)`, "g");
  const indices = new Set<number>();
  for (const match of content.matchAll(pattern)) {
    const index = Number(match[1]);
    if (Number.isInteger(index) && index >= 0) indices.add(index);
  }
  let complete = true;
  await Promise.all([...indices].map(async (index) => {
    try {
      if (await getOfflineResource(id, version, String(index))) return;
      const response = await fetchWithTimeout(`/api/v1/books/${id}/resource/${index}`, {
        credentials: "same-origin",
        headers: { "If-Match": `"${version}"` },
      });
      if (!response.ok) {
        complete = false;
        return;
      }
      const etag = response.headers.get("etag")?.trim();
      if (etag !== `"${version}"`) {
        complete = false;
        return;
      }
      const blob = await response.blob();
      await saveOfflineResource(
        id,
        version,
        String(index),
        blob,
        blob.type,
        response.headers.get("x-moth-resource-path") ?? undefined,
      );
    } catch {
      complete = false;
    }
  }));
  return complete;
}

export const api = {
  getSetupStatus: async () => {
    // A cached reading unit is enough to open the local shell. Return it
    // without waiting for a server request when the device is offline.
    if (offline()) {
      try {
        if (await hasOfflineBooks()) return { initialized: true };
      } catch {
        // Fall through to the normal request for browsers without IndexedDB.
      }
    }
    try {
      return await request<SetupStatus>("/setup/status");
    } catch (error) {
      if (!mayUseCachedContent(error)) throw error;
      try {
        if (await hasOfflineBooks()) return { initialized: true };
      } catch {
        // IndexedDB is unavailable in some browsers and test environments.
      }
      throw error;
    }
  },
  setup: (username: string, password: string) =>
    request<SetupStatus>("/setup", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  login: async (username: string, password: string) => {
    await request<void>("/session", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    unfreezeOfflineStorage();
    setOfflineScope(username.trim());
  },
  getSession: async () => {
    if (offline()) {
      try {
        if (await hasOfflineBooks()) return { authenticated: true, username: "Offline", offline: true };
      } catch {
        // Continue with the server request when IndexedDB is unavailable.
      }
    }
    if (hasPendingLogout()) {
      try {
        await request<void>("/session", { method: "DELETE" });
        clearPendingLogout();
      } catch {
        // Keep the marker so the next online attempt retries before reading the session.
      }
    }
    try {
      const session = await request<SessionState>("/session");
      // Even an unauthenticated response carries the server identity. If a
      // self-hosted instance was rebuilt at the same origin, move to a fresh
      // anonymous scope before checking for local books so old data cannot be
      // presented as belonging to the replacement server.
      reconcileOfflineInstance(session.instance_id);
      if (session.authenticated && session.username) {
        setOfflineScope(session.username, session.instance_id, session.account_id);
      } else if (!session.authenticated) {
        // An expired/revoked cookie must not strand books already stored on
        // this device. Keep the app in local-only mode until the user signs
        // in again; server operations will still surface 401 and remain
        // queued by the reader.
        try {
          if (await hasOfflineBooks()) return { authenticated: true, username: "Offline", offline: true };
        } catch {
          // IndexedDB is optional; retain the server's unauthenticated state.
        }
      }
      return session;
    } catch (error) {
      if (!mayUseCachedContent(error)) throw error;
      try {
        if (await hasOfflineBooks()) return { authenticated: true, username: "Offline", offline: true };
      } catch {
        // Preserve the original network/API error when local storage is unavailable.
      }
      throw error;
    }
  },
  logout: async () => {
    freezeOfflineStorage();
    cancelProgressRequests();
    try {
      // Finish IndexedDB writes before the sign-out request. This establishes
      // a clear local boundary while the cookie is still available, and the
      // aborted progress requests cannot repopulate storage afterwards.
      await drainOfflineWrites();
      if (await tryServerLogout()) clearPendingLogout();
      else throw new Error("server logout deferred");
    } catch {
      // The local logout is immediate; retry the server-side logout after reconnect.
      setPendingLogout();
    } finally {
      try {
        await clearOfflineData();
        await clearMothCaches();
      } finally {
        setOfflineScope(null);
        clearLocalReaderPreferences();
      }
    }
  },
  flushPendingLogout: async () => {
    if (!hasPendingLogout()) return;
    try {
      if (await tryServerLogout()) clearPendingLogout();
    } catch {
      // Leave the marker for the next reconnect or session check.
    }
  },
  flushPendingProgress: async () => {
    if (progressFlushPromise) return progressFlushPromise;
    progressFlushPromise = (async () => {
      // Re-read after every response. A reader can replace the queued
      // operation while an older request is in flight; acknowledgeProgress
      // then advances the new operation's base revision and returns false.
      // Continuing with the original snapshot would leave that newer write
      // stranded until another online/foreground event.
      while (!isOfflineStorageFrozen() && !(typeof navigator !== "undefined" && !navigator.onLine)) {
        let operation;
        try {
          const pending = await listPendingProgress();
          operation = pending[0];
        } catch {
          return;
        }
        if (!operation) return;
        try {
          const result = await progressRequest<{
            progress: ProgressBody;
            revision: number;
            conflict: boolean;
          }>(`${operation.bookId}:${operation.contentVersion}:${operation.value.encoding ?? "none"}`, `/books/${operation.bookId}/progress/sync`, {
            method: "POST",
            body: JSON.stringify({
              ...operation.value,
              content_version: operation.contentVersion,
              base_revision: operation.baseRevision,
              operation_id: operation.operationId,
              ...(operation.value.encoding ? { encoding: operation.value.encoding } : {}),
            }),
          });
          await acknowledgeProgress(operation, {
            ...result.progress,
            encoding: result.progress.encoding ?? operation.value.encoding,
          }, result.revision);
        } catch (error) {
          // A changed file can never accept a progress operation from the old
          // content version. Drop that operation; other failures remain queued
          // for the next connection or login attempt.
          if (error instanceof ApiError && error.code === "content_changed") {
            await removePendingProgress(operation.key);
            continue;
          }
          return;
        }
      }
    })();
    try {
      await progressFlushPromise;
    } finally {
      progressFlushPromise = null;
    }
  },
  hasPendingProgress: async () => {
    try {
      return (await listPendingProgress()).length > 0;
    } catch {
      return false;
    }
  },
  getBooks: async (filters?: { section_id?: number; series_id?: number }) => {
    const params = new URLSearchParams();
    if (filters?.section_id !== undefined) params.set("section_id", String(filters.section_id));
    if (filters?.series_id !== undefined) params.set("series_id", String(filters.series_id));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    try {
      const books = await request<BookSummary[]>(`/books${suffix}`);
      await Promise.all(books.map((book) => saveOfflineBookSummary(book).catch(() => undefined)));
      return books;
    } catch (error) {
      if (!mayUseCachedContent(error)) throw error;
      try {
      const cached = await getOfflineBooks();
        const filtered = cached.filter((book) =>
          (filters?.section_id === undefined || book.section_id === filters.section_id)
          && (filters?.series_id === undefined || book.series_id === filters.series_id),
        );
        if (filtered.length > 0 || offline()) return filtered;
      } catch {
        // Preserve the original network/API error when local storage is unavailable.
      }
      throw error;
    }
  },
  clearOfflineContent: () => clearOfflineContent(),
  getSections: async () => {
    const asFallback = async (): Promise<SectionSummary[]> => {
      const [snapshot, books] = await Promise.all([
        getOfflineSections().catch(() => null),
        getOfflineBooks().catch(() => []),
      ]);
      if (snapshot && Array.isArray(snapshot)) {
        const cached = new Map(books.map((book) => [book.id, book]));
        return snapshot
          .map((section) => {
            const sectionBooks = section.books.filter((book) => cached.has(book.id));
            const series = section.series.map((item) => {
              const seriesBooks = item.books.filter((book) => cached.has(book.id));
              return { ...item, books: seriesBooks, book_count: seriesBooks.length };
            });
            return {
              ...section,
              books: sectionBooks,
              series,
              book_count: sectionBooks.length + series.reduce((total, item) => total + item.book_count, 0),
            };
          })
          .filter((section) => section.books.length > 0 || section.series.some((series) => series.books.length > 0) || section.is_system);
      }
      return [{
        id: 0,
        name: "Unclassified",
        sort_order: 0,
        is_system: true,
        book_count: books.length,
        series: [],
        books,
      }];
    };
    try {
      const sections = await request<unknown>("/sections");
      if (!Array.isArray(sections)) return asFallback();
      const typed = sections as SectionSummary[];
      await saveOfflineSections(typed).catch(() => undefined);
      await Promise.all(typed.flatMap((section) => [
        ...section.books.map((book) => saveOfflineBookSummary(book)),
        ...section.series.flatMap((series) => series.books.map((book) => saveOfflineBookSummary(book))),
      ].map((promise) => promise.catch(() => undefined))));
      return typed;
    } catch (error) {
      if (!mayUseCachedContent(error)) throw error;
      return asFallback();
    }
  },
  createSection: (name: string) => request<SectionSummary>("/sections", {
    method: "POST",
    body: JSON.stringify({ name }),
  }),
  updateSection: (id: number, patch: { name?: string; sort_order?: number }) => request<SectionSummary>(`/sections/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }),
  deleteSection: (id: number) => request<void>(`/sections/${id}`, { method: "DELETE" }),
  reorderSections: (ids: number[]) => request<void>("/sections/reorder", {
    method: "POST",
    body: JSON.stringify({ ids }),
  }),
  createSeries: (name: string, section_id: number) => request<SeriesSummary>("/series", {
    method: "POST",
    body: JSON.stringify({ name, section_id }),
  }),
  getSeries: (id: number) => request<SeriesSummary>(`/series/${id}`),
  updateSeries: (id: number, patch: { name?: string; section_id?: number; sort_order?: number }) => request<SeriesSummary>(`/series/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }),
  deleteSeries: (id: number) => request<void>(`/series/${id}`, { method: "DELETE" }),
  organizeBooks: (book_ids: number[], target: { section_id?: number; series_id?: number }) => request<void>("/books/organize", {
    method: "POST",
    body: JSON.stringify({ book_ids, ...target }),
  }),
  reorderSeriesBooks: (id: number, ids: number[]) => request<void>(`/series/${id}/books/reorder`, {
    method: "POST",
    body: JSON.stringify({ ids }),
  }),
  deleteMissingBook: (id: number) => request<void>(`/books/${id}`, { method: "DELETE" }),
  getBook: async (id: number, encoding?: string) => {
    const suffix = encoding ? `?encoding=${encodeURIComponent(encoding)}` : "";
    try {
      const book = await request<BookDetail>(`/books/${id}${suffix}`);
      await saveOfflineBookSummary(book, book, undefined, encoding).catch(() => undefined);
      if (book.has_cover && book.cover_url) {
        void fetchWithTimeout(book.cover_url, {
          credentials: "same-origin",
          headers: { "If-Match": `"${book.content_version}"` },
        }).then(async (response) => {
          if (response.ok && response.headers.get("etag")?.trim() === `"${book.content_version}"`) {
            await saveOfflineCover(book.id, book.content_version, await response.blob());
          }
        }).catch(() => undefined);
      }
      return book;
    } catch (error) {
      if (!mayUseCachedContent(error)) throw error;
      try {
        const cached = await getOfflineBook(id, encoding);
        if (cached) return cached;
      } catch {
        // Preserve the original network/API error when local storage is unavailable.
      }
      if (offline()) {
        throw new ApiError(503, "offline_unavailable", "This book is not cached on this device. Connect to the server to open it.");
      }
      throw error;
    }
  },
  getOfflineManifest: (id: number, encoding?: string) =>
    request<OfflineManifest>(
      `/books/${id}/offline-manifest${encoding ? `?encoding=${encodeURIComponent(encoding)}` : ""}`,
    ),
  getChapter: async (id: number, idx: number, encoding?: string, contentVersion?: string, parserVersion?: string) => {
    const headers = contentVersion ? { "If-Match": `"${contentVersion}"` } : undefined;
    try {
      const chapter = await request<ChapterContent>(
        `/books/${id}/chapter/${idx}${encoding ? `?encoding=${encodeURIComponent(encoding)}` : ""}`,
        headers ? { headers } : undefined,
        contentVersion,
      );
      const version = contentVersion ?? (await getOfflineBook(id, encoding))?.content_version;
      if (version) {
        // Cache failures (including a slow resource endpoint) must never hold
        // up the chapter the reader already received from the server. A text
        // unit has no dependent resources; for EPUB/MOBI wait for every
        // referenced server resource before making the chapter an offline
        // readable unit.
        void (async () => {
          const resourcesReady = await cacheChapterResources(id, version, chapter.content);
          if (!resourcesReady) return;
          await saveOfflineChapter(id, version, idx, encoding ?? "", chapter, chapter.parser_version ?? parserVersion).catch(() => undefined);
        })();
      }
      return chapter;
    } catch (error) {
      if (!mayUseCachedContent(error)) throw error;
      try {
        const detail = await getOfflineBook(id, encoding);
        const expectedVersion = contentVersion ?? detail?.content_version;
        const cached = detail && expectedVersion === detail.content_version
          ? await getOfflineChapter(id, expectedVersion, idx, encoding, parserVersion)
          : null;
        // A precondition failure means the server changed the book while the
        // reader was open. Serving an older cached chapter would mix content
        // versions, so surface the error and let the reader reopen it.
        if (cached && !isContentVersionError(error)) {
          return { idx, ...cached };
        }
      } catch {
        // Preserve the original network/API error when local storage is unavailable.
      }
      if (offline()) {
        throw new ApiError(503, "offline_unavailable", "This chapter is not cached yet. Connect to the server to continue reading.");
      }
      throw error;
    }
  },
  getPage: async (id: number, idx: number, contentVersion?: string) => {
    const headers = contentVersion ? { "If-Match": `"${contentVersion}"` } : undefined;
    try {
      const response = await fetchWithTimeout(`/api/v1/books/${id}/page/${idx}`, {
        credentials: "same-origin",
        headers,
      });
      if (!response.ok) {
        throw new ApiError(response.status, "request_failed", `Could not load page (${response.status}).`);
      }
      if (contentVersion) {
        const etag = response.headers.get("etag")?.trim();
        if (etag !== `"${contentVersion}"`) {
          throw new ApiError(412, "content_changed", "The book changed; refresh before continuing.");
        }
      }
      const blob = await response.blob();
      const version = contentVersion ?? (await getOfflineBook(id))?.content_version;
      if (version) {
        void saveOfflinePage(id, version, idx, blob, String(idx), blob.type).catch(() => undefined);
      }
      return blob;
    } catch (error) {
      if (!mayUseCachedContent(error)) throw error;
      if (contentVersion) {
        const cached = await getOfflinePage(id, contentVersion, idx).catch(() => null);
        if (cached) return cached.data;
      }
      if (offline()) throw new ApiError(503, "offline_unavailable", "This page is not cached yet. Connect to the server to continue reading.");
      throw error;
    }
  },
  getProgress: (id: number) => request<ProgressBody>(`/books/${id}/progress`),
  putProgress: (id: number, progress: ProgressBody) =>
    request<void>(`/books/${id}/progress`, {
      method: "PUT",
      body: JSON.stringify(progress),
    }),
  syncProgress: (id: number, progress: {
    chapter_index: number;
    page_index: number;
    percent: number;
    content_version: string;
    base_revision: number;
    operation_id: string;
    cfi?: string;
    encoding?: string;
  }) => progressRequest<{
    progress: ProgressBody;
    revision: number;
    conflict: boolean;
  }>(`${id}:${progress.content_version}:${progress.encoding ?? "none"}`, `/books/${id}/progress/sync`, {
    method: "POST",
    body: JSON.stringify(progress),
  }),
  scanLibrary: () => request<void>("/library/scan", { method: "POST" }),
  getScanStatus: () => request<ScanStatus>("/library/scan/status"),
};

/** URL of a book's raw file, served with HTTP Range support. */
export const bookFileUrl = (id: number) => `/api/v1/books/${id}/file`;

