import {
  clearOfflineData,
  getOfflineBook,
  getOfflineBooks,
  getOfflineChapter,
  hasOfflineBooks,
  listPendingProgress,
  removePendingProgress,
  saveLocalProgress,
  saveOfflineChapter,
  setOfflineScope,
} from "./offline/db";

export type SetupStatus = {
  initialized: boolean;
};

export type SessionState = {
  authenticated: boolean;
  username?: string;
  offline?: boolean;
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
  progress?: ProgressBody;
};

export type ChapterContent = {
  idx: number;
  title: string;
  content: string;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`/api/v1${path}`, {
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
  return (await response.json()) as T;
}

export const api = {
  getSetupStatus: async () => {
    try {
      return await request<SetupStatus>("/setup/status");
    } catch (error) {
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
    setOfflineScope(username.trim());
  },
  getSession: async () => {
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
      if (session.authenticated && session.username) {
        setOfflineScope(session.username);
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
      try {
        if (await hasOfflineBooks()) return { authenticated: true, username: "Offline", offline: true };
      } catch {
        // Preserve the original network/API error when local storage is unavailable.
      }
      throw error;
    }
  },
  logout: async () => {
    try {
      await request<void>("/session", { method: "DELETE" });
      clearPendingLogout();
    } catch {
      // The local logout is immediate; retry the server-side logout after reconnect.
      setPendingLogout();
    } finally {
      try {
        await clearOfflineData();
      } finally {
        setOfflineScope(null);
        clearLocalReaderPreferences();
      }
    }
  },
  flushPendingLogout: async () => {
    if (!hasPendingLogout()) return;
    try {
      await request<void>("/session", { method: "DELETE" });
      clearPendingLogout();
    } catch {
      // Leave the marker for the next reconnect or session check.
    }
  },
  flushPendingProgress: async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    let pending;
    try {
      pending = await listPendingProgress();
    } catch {
      return;
    }
    for (const operation of pending) {
      try {
        const result = await request<{
          progress: ProgressBody;
          revision: number;
          conflict: boolean;
        }>(`/books/${operation.bookId}/progress/sync`, {
          method: "POST",
          body: JSON.stringify({
            ...operation.value,
            content_version: operation.contentVersion,
            base_revision: operation.baseRevision,
            operation_id: operation.operationId,
            ...(operation.value.encoding ? { encoding: operation.value.encoding } : {}),
          }),
        });
        await saveLocalProgress(operation.bookId, operation.contentVersion, {
          ...result.progress,
          revision: result.revision,
          content_version: operation.contentVersion,
          encoding: result.progress.encoding ?? operation.value.encoding,
        });
        await removePendingProgress(operation.key);
      } catch (error) {
        // A changed file can never accept a progress operation from the old
        // content version. Drop that operation; other failures remain queued
        // for the next connection or login attempt.
        if (error instanceof ApiError && error.code === "content_changed") {
          await removePendingProgress(operation.key);
          continue;
        }
        break;
      }
    }
  },
  hasPendingProgress: async () => {
    try {
      return (await listPendingProgress()).length > 0;
    } catch {
      return false;
    }
  },
  getBooks: async () => {
    try {
      return await request<BookSummary[]>("/books");
    } catch (error) {
      try {
        const cached = await getOfflineBooks();
        if (cached.length > 0 || offline()) return cached;
      } catch {
        // Preserve the original network/API error when local storage is unavailable.
      }
      throw error;
    }
  },
  getBook: async (id: number, encoding?: string) => {
    const suffix = encoding ? `?encoding=${encodeURIComponent(encoding)}` : "";
    try {
      return await request<BookDetail>(`/books/${id}${suffix}`);
    } catch (error) {
      try {
        const cached = await getOfflineBook(id);
        if (cached) return cached;
      } catch {
        // Preserve the original network/API error when local storage is unavailable.
      }
      if (offline()) {
        throw new ApiError(503, "offline_unavailable", "This book is not downloaded for offline reading.");
      }
      throw error;
    }
  },
  getOfflineManifest: (id: number, encoding?: string) =>
    request<OfflineManifest>(
      `/books/${id}/offline-manifest${encoding ? `?encoding=${encodeURIComponent(encoding)}` : ""}`,
    ),
  getChapter: async (id: number, idx: number, encoding?: string, contentVersion?: string) => {
    const headers = contentVersion ? { "If-Match": `"${contentVersion}"` } : undefined;
    try {
      const chapter = await request<ChapterContent>(
        `/books/${id}/chapter/${idx}${encoding ? `?encoding=${encodeURIComponent(encoding)}` : ""}`,
        headers ? { headers } : undefined,
      );
      try {
        const detail = await getOfflineBook(id);
        if (detail) {
          await saveOfflineChapter(id, detail.content_version, idx, encoding ?? "", chapter);
        }
      } catch {
        // IndexedDB is optional; a successful network response remains usable.
      }
      return chapter;
    } catch (error) {
      try {
        const detail = await getOfflineBook(id);
        const cached = detail
          ? await getOfflineChapter(id, detail.content_version, idx, encoding)
          : null;
        // A precondition failure means the server changed the book while the
        // reader was open. Serving an older cached chapter would mix content
        // versions, so surface the error and let the reader reopen it.
        if (cached && !(error instanceof ApiError && error.status === 412)) {
          return { idx, ...cached };
        }
      } catch {
        // Preserve the original network/API error when local storage is unavailable.
      }
      if (offline()) {
        throw new ApiError(503, "offline_unavailable", "This chapter is not downloaded for offline reading.");
      }
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
  }) => request<{
    progress: ProgressBody;
    revision: number;
    conflict: boolean;
  }>(`/books/${id}/progress/sync`, {
    method: "POST",
    body: JSON.stringify(progress),
  }),
  scanLibrary: () => request<void>("/library/scan", { method: "POST" }),
  getScanStatus: () => request<ScanStatus>("/library/scan/status"),
};

/** URL of a book's raw file, served with HTTP Range support. */
export const bookFileUrl = (id: number) => `/api/v1/books/${id}/file`;

