import type { BookDetail, BookSummary, ChapterInfo, ProgressBody } from "../api";

/**
 * Browser storage for the online first reader.
 *
 * A book record is only metadata. Reading units live in their own stores and
 * are keyed by the server content hash, so a rescan can never make an older
 * chapter or page look like the current one. The database name includes the
 * server instance and account to isolate two self-hosted servers that happen
 * to use the same origin.
 */
const DB_NAME = "moth-reader-v3";
const DB_VERSION = 4;
const SCOPE_STORAGE_KEY = "moth:offline-scope";
const TXT_PARSER_VERSION = "txt-v1";

type StoredBook = {
  id: number;
  summary: BookSummary;
  detail: BookDetail;
  cover?: Blob;
  /** Complete metadata/TOC for each TXT decoder used on this device. */
  details?: Record<string, BookDetail>;
  /** Last selected decoder. This is a preference, never cache identity. */
  txtEncoding?: string;
  contentVersion: string;
  /** Legacy full-download key. New unit caches do not depend on it. */
  storageKey?: string;
  complete?: boolean;
  hasCachedContent?: boolean;
  cachedUnits?: number;
  cachedPages?: number;
  downloadedAt?: number;
  serverInstanceId?: string;
  accountId?: string;
};

type StoredChunk = {
  key: string;
  bookId: number;
  contentVersion: string;
  storageKey?: string;
  index: number;
  data: ArrayBuffer;
};

export type CachedChapter = {
  key: string;
  bookId: number;
  contentVersion: string;
  idx: number;
  encoding: string;
  parserVersion: string;
  title: string;
  content: string;
  cachedAt: number;
};

export type CachedPage = {
  key: string;
  bookId: number;
  contentVersion: string;
  idx: number;
  name: string;
  mime: string;
  data: Blob;
  cachedAt: number;
};

export type CachedResource = {
  key: string;
  bookId: number;
  contentVersion: string;
  path: string;
  /** Original archive path, when a numeric chapter alias was also stored. */
  sourcePath?: string;
  mime: string;
  data: Blob;
  cachedAt: number;
};

type StoredProgress = {
  bookId: number;
  value: ProgressBody;
  contentVersion: string;
  encoding?: string;
  updatedAt: number;
  localSequence: number;
};

type StoredProgressContext = StoredProgress & {
  key: string;
};

export type PendingProgress = {
  key: string;
  bookId: number;
  contentVersion: string;
  value: ProgressBody;
  baseRevision: number;
  operationId: string;
  createdAt: number;
  localSequence: number;
};

export type OfflineContentStatus = {
  hasContent: boolean;
  chapterCount: number;
  pageCount: number;
  /** Legacy full-file chunks are reported for diagnostics only. */
  legacyFile: boolean;
};

type OfflineScope = {
  username?: string;
  accountId?: string;
  instanceId?: string;
};

let storageFrozen = false;
let activeWriteTransactions = 0;
let drainResolvers: Array<() => void> = [];

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function announceStorageEvent(type: "quota" | "cleared"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("moth-offline-storage", { detail: { type } }));
}

function readScope(): OfflineScope {
  try {
    const raw = localStorage.getItem(SCOPE_STORAGE_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as OfflineScope;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // v2 stored the username as plain text. Keep it readable during upgrade.
      return { username: raw };
    }
  } catch {
    // Private browsing can deny localStorage. Origin still gives isolation.
  }
  return {};
}

function databaseName(): string {
  const scope = readScope();
  const origin = typeof location !== "undefined" ? location.origin : "unknown-origin";
  const identity = [origin, scope.instanceId || "unknown-instance", scope.accountId || scope.username || "anonymous"].join("|");
  return `${DB_NAME}-${encodeURIComponent(identity)}`;
}

/** Set the identity used to isolate subsequent local reads and writes. */
export function setOfflineScope(username: string | null, instanceId?: string, accountId?: string): void {
  try {
    if (!username?.trim() && !instanceId?.trim() && !accountId?.trim()) {
      localStorage.removeItem(SCOPE_STORAGE_KEY);
      return;
    }
    // A username-only call is used immediately after login, before the
    // session response has supplied the server instance. Do not retain an
    // instance/account pair from a previous server at the same origin while
    // that identity is being resolved.
    const hasServerIdentity = instanceId !== undefined || accountId !== undefined;
    const next: OfflineScope = {
      username: username?.trim() || undefined,
      instanceId: hasServerIdentity ? instanceId?.trim() || undefined : undefined,
      accountId: hasServerIdentity ? accountId?.trim() || undefined : undefined,
    };
    localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // IndexedDB remains usable when localStorage is unavailable.
  }
}

/**
 * Reconcile the server identity before using a local-only session. When a
 * cookie expires on the same server, retaining the account scope keeps the
 * visited chapters readable. If the server instance changed at this origin,
 * switch to an anonymous scope so data from the previous installation cannot
 * appear under the replacement server.
 */
export function reconcileOfflineInstance(instanceId?: string): void {
  const nextInstance = instanceId?.trim();
  if (!nextInstance) return;
  try {
    const current = readScope();
    if (current.instanceId === nextInstance) return;
    localStorage.setItem(SCOPE_STORAGE_KEY, JSON.stringify({ instanceId: nextInstance } satisfies OfflineScope));
  } catch {
    // Without localStorage there is no durable scope to reconcile. The
    // database name still includes the origin and cannot cross origins.
  }
}

/** Freeze writers while logout drains in-flight work. Login unfreezes them. */
export function freezeOfflineStorage(): void {
  storageFrozen = true;
}

export function unfreezeOfflineStorage(): void {
  storageFrozen = false;
}

export function isOfflineStorageFrozen(): boolean {
  return storageFrozen;
}

/** Wait for writers that started before logout froze the storage. */
export async function drainOfflineWrites(): Promise<void> {
  if (activeWriteTransactions === 0) return;
  await new Promise<void>((resolve) => drainResolvers.push(resolve));
}

function request<T>(requestValue: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    requestValue.onsuccess = () => resolve(requestValue.result);
    requestValue.onerror = () => reject(requestValue.error ?? new Error("IndexedDB request failed"));
  });
}

function cursorValues<T>(store: IDBObjectStore | IDBIndex, range?: IDBKeyRange): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const values: T[] = [];
    const cursor = store.openCursor(range);
    cursor.onsuccess = () => {
      const value = cursor.result;
      if (!value) {
        resolve(values);
        return;
      }
      values.push(value.value as T);
      value.continue();
    };
    cursor.onerror = () => reject(cursor.error ?? new Error("IndexedDB cursor failed"));
  });
}

function cursorMap<T, U>(
  store: IDBObjectStore | IDBIndex,
  map: (value: T) => U | null,
  range?: IDBKeyRange,
): Promise<U[]> {
  return new Promise((resolve, reject) => {
    const values: U[] = [];
    const cursor = store.openCursor(range);
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) {
        resolve(values);
        return;
      }
      const mapped = map(entry.value as T);
      if (mapped !== null) values.push(mapped);
      entry.continue();
    };
    cursor.onerror = () => reject(cursor.error ?? new Error("IndexedDB cursor failed"));
  });
}

function cursorCount(store: IDBObjectStore | IDBIndex, range?: IDBKeyRange): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const cursor = store.openCursor(range);
    cursor.onsuccess = () => {
      if (!cursor.result) {
        resolve(count);
        return;
      }
      count += 1;
      cursor.result.continue();
    };
    cursor.onerror = () => reject(cursor.error ?? new Error("IndexedDB cursor failed"));
  });
}

function isTrustedChapter(value: CachedChapter): boolean {
  // Records from the removed whole-book download schema did not carry a
  // parser version. They remain available for explicit cleanup diagnostics,
  // but must never make a book look cached or be served as a reading unit.
  return typeof value.parserVersion === "string" && value.parserVersion.trim().length > 0;
}

function trustedChapterCount(
  store: IDBObjectStore | IDBIndex,
  range: IDBKeyRange,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const cursor = store.openCursor(range);
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) {
        resolve(count);
        return;
      }
      if (isTrustedChapter(entry.value as CachedChapter)) count += 1;
      entry.continue();
    };
    cursor.onerror = () => reject(cursor.error ?? new Error("IndexedDB cursor failed"));
  });
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName(), DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      const create = (name: string, options?: IDBObjectStoreParameters): IDBObjectStore => {
        if (db.objectStoreNames.contains(name)) return open.transaction!.objectStore(name);
        return db.createObjectStore(name, options);
      };
      const staged = create("staged", { keyPath: "key" });
      const chunks = create("chunks", { keyPath: "key" });
      const chapters = create("chapters", { keyPath: "key" });
      const pages = create("pages", { keyPath: "key" });
      const resources = create("resources", { keyPath: "key" });
      const progress = create("progress", { keyPath: "bookId" });
      const progressByContext = create("progressByContext", { keyPath: "key" });
      const queue = create("queue", { keyPath: "key" });
      create("books", { keyPath: "id" });

      // Indexes let cleanup and offline shelf reads avoid loading binary
      // payloads with getAll(). This upgrade is safe for the previous schema.
      const addIndex = (store: IDBObjectStore, name: string, keyPath: string | string[]) => {
        if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
      };
      addIndex(staged, "bookVersion", ["id", "contentVersion"]);
      addIndex(chunks, "bookVersion", ["bookId", "contentVersion"]);
      addIndex(chapters, "bookVersion", ["bookId", "contentVersion"]);
      addIndex(pages, "bookVersion", ["bookId", "contentVersion"]);
      addIndex(resources, "bookVersion", ["bookId", "contentVersion"]);
      addIndex(resources, "bookVersionSourcePath", ["bookId", "contentVersion", "sourcePath"]);
      addIndex(queue, "bookId", "bookId");
      addIndex(progress, "contentVersion", ["bookId", "contentVersion"]);
      addIndex(progressByContext, "bookVersionEncoding", ["bookId", "contentVersion", "encoding"]);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("Could not open offline storage"));
  });
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const isWrite = mode === "readwrite";
  // Count the operation before opening IndexedDB. Cache writes are often
  // fire-and-forget; if logout freezes storage while database() is still
  // opening, drainOfflineWrites must nevertheless wait for that writer to
  // either commit or observe the frozen state.
  if (isWrite) activeWriteTransactions += 1;
  let db: IDBDatabase | undefined;
  let tx: IDBTransaction | undefined;
  try {
    db = await database();
    const activeTx = db.transaction(stores, mode);
    tx = activeTx;
    const result = await run(activeTx);
    await new Promise<void>((resolve, reject) => {
      activeTx.oncomplete = () => resolve();
      activeTx.onerror = () => reject(activeTx.error ?? new Error("IndexedDB transaction failed"));
      activeTx.onabort = () => reject(activeTx.error ?? new Error("IndexedDB transaction aborted"));
    });
    return result;
  } catch (error) {
    if (isQuotaError(error) || isQuotaError(tx?.error)) announceStorageEvent("quota");
    throw error;
  } finally {
    db?.close();
    if (isWrite) {
      activeWriteTransactions -= 1;
      if (activeWriteTransactions === 0) {
        const resolvers = drainResolvers;
        drainResolvers = [];
        resolvers.forEach((resolve) => resolve());
      }
    }
  }
}

function normalizeEncoding(encoding?: string): string {
  return encoding?.trim().toLowerCase() || "auto";
}

function normalizeParserVersion(parserVersion?: string): string {
  return parserVersion?.trim() || TXT_PARSER_VERSION;
}

function randomId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function chapterKey(bookId: number, version: string, idx: number, encoding: string, parserVersion: string): string {
  return `${bookId}:${version}:chapter:${encodeURIComponent(normalizeEncoding(encoding))}:${encodeURIComponent(parserVersion)}:${idx}`;
}

function pageKey(bookId: number, version: string, idx: number): string {
  return `${bookId}:${version}:page:${idx}`;
}

function progressKey(bookId: number, version: string, encoding?: string): string {
  return `${bookId}:${version}:progress:${normalizeEncoding(encoding)}`;
}

function asDetail(summary: BookSummary, detail?: BookDetail): BookDetail {
  return detail ?? { ...summary, chapters: [] };
}

function detailKey(format: BookSummary["format"], encoding?: string): string {
  return format === "txt" ? normalizeEncoding(encoding) : "default";
}

async function readBook(tx: IDBTransaction, id: number): Promise<StoredBook | undefined> {
  return (await request(tx.objectStore("books").get(id))) as StoredBook | undefined;
}

export async function saveOfflineBookSummary(summary: BookSummary, detail?: BookDetail, identity?: { instanceId?: string; accountId?: string }, encoding?: string): Promise<void> {
  if (storageFrozen) return;
  await transaction(["books"], "readwrite", async (tx) => {
    const store = tx.objectStore("books");
    const existing = (await request(store.get(summary.id))) as StoredBook | undefined;
    const sameVersion = existing?.contentVersion === summary.content_version;
    const details = sameVersion ? { ...(existing?.details ?? {}) } : {};
    if (detail) details[detailKey(summary.format, encoding)] = detail;
    const selectedDetail = details[detailKey(summary.format, encoding)]
      ?? (sameVersion ? existing?.detail : undefined)
      ?? asDetail(summary);
    const next: StoredBook = {
      ...existing,
      id: summary.id,
      summary: sameVersion ? { ...(existing?.summary ?? summary), ...summary } : { ...summary },
      // Keep the canonical metadata/TOC independent from a TXT decoder
      // preference. Explicit encoding reads are stored in chapter keys, while
      // the book detail remains the first complete server description.
      detail: selectedDetail,
      details,
      contentVersion: summary.content_version,
      // A cover is derived from the book bytes too. Never expose the previous
      // version's blob under the new content hash.
      cover: sameVersion ? existing?.cover : undefined,
      hasCachedContent: sameVersion ? existing?.hasCachedContent : false,
      cachedUnits: sameVersion ? existing?.cachedUnits : 0,
      cachedPages: sameVersion ? existing?.cachedPages : 0,
      serverInstanceId: identity?.instanceId ?? existing?.serverInstanceId,
      accountId: identity?.accountId ?? existing?.accountId,
    };
    store.put(next);
    return undefined;
  });
}

export async function getOfflineBooks(): Promise<BookSummary[]> {
  return transaction(["books", "chapters", "pages"], "readonly", async (tx) => {
    const books = await cursorValues<StoredBook>(tx.objectStore("books"));
    const chapterIndex = tx.objectStore("chapters").index("bookVersion");
    const pageIndex = tx.objectStore("pages").index("bookVersion");
    const cached: BookSummary[] = [];
    for (const book of books) {
      // The counters on the metadata record are only a hint. A failed or
      // interrupted write must not make an uncached book appear in the
      // offline shelf, so verify the actual unit indexes before exposing it.
      const [chapterCount, pageCount] = await Promise.all([
        trustedChapterCount(chapterIndex, IDBKeyRange.only([book.id, book.contentVersion])),
        cursorCount(pageIndex, IDBKeyRange.only([book.id, book.contentVersion])),
      ]);
      // Legacy `complete` records describe the removed whole-book download
      // flow. They remain in the database for cleanup/migration diagnostics,
      // but are never a trusted source for the online-first reader.
      if (chapterCount || pageCount) {
        cached.push({ ...book.summary, cached_content: true } as BookSummary & { cached_content: boolean });
      }
    }
    return cached;
  });
}

export async function getOfflineBook(id: number, encoding?: string): Promise<BookDetail | null> {
  return transaction(["books", "chapters", "pages"], "readonly", async (tx) => {
    const book = await readBook(tx, id);
    // Metadata from a legacy full-book record is not enough to open a cached
    // unit. Require a chapter/page written by the new reader before exposing
    // this detail as an offline entry point.
    if (!book) return null;
    const [chapterCount, pageCount] = await Promise.all([
      trustedChapterCount(tx.objectStore("chapters").index("bookVersion"), IDBKeyRange.only([id, book.contentVersion])),
      cursorCount(tx.objectStore("pages").index("bookVersion"), IDBKeyRange.only([id, book.contentVersion])),
    ]);
    if (chapterCount === 0 && pageCount === 0) return null;
    let detail = book.details?.[detailKey(book.summary.format, encoding)] ?? book.detail;
    detail = detail?.content_version === book.contentVersion ? detail : asDetail(book.summary);
    if (detail.chapters.length === 0 && chapterCount > 0) {
      const requestedEncoding = normalizeEncoding(encoding);
      const cached = await cursorMap<CachedChapter, ChapterInfo>(
        tx.objectStore("chapters").index("bookVersion"),
        (chapter) => {
          if (!isTrustedChapter(chapter)) return null;
          if (book.summary.format === "txt" && chapter.encoding !== requestedEncoding) return null;
          return { idx: chapter.idx, title: chapter.title, size: chapter.content.length };
        },
        IDBKeyRange.only([id, book.contentVersion]),
      );
      const chapters = [...new Map(cached.sort((a, b) => a.idx - b.idx).map((chapter) => [chapter.idx, chapter])).values()];
      if (chapters.length) detail = { ...detail, chapters };
    }
    return detail;
  });
}

export async function getOfflineCover(id: number, version: string): Promise<Blob | null> {
  return transaction(["books"], "readonly", async (tx) => {
    const book = await readBook(tx, id);
    return book?.contentVersion === version && book.cover ? book.cover : null;
  });
}

export async function saveOfflineCover(id: number, version: string, cover: Blob): Promise<void> {
  if (storageFrozen) return;
  await transaction(["books"], "readwrite", async (tx) => {
    const book = await readBook(tx, id);
    if (book?.contentVersion === version) {
      book.cover = cover;
      tx.objectStore("books").put(book);
    }
    return undefined;
  });
}

export async function getOfflineTxtEncoding(id: number, version: string): Promise<string> {
  return transaction(["books"], "readonly", async (tx) => {
    const book = await readBook(tx, id);
    return book?.contentVersion === version ? book.txtEncoding ?? "auto" : "";
  });
}

export async function setOfflineTxtEncoding(id: number, version: string, encoding: string): Promise<void> {
  if (storageFrozen) return;
  await transaction(["books"], "readwrite", async (tx) => {
    const store = tx.objectStore("books");
    const book = await readBook(tx, id);
    if (book?.contentVersion === version) {
      book.txtEncoding = encoding || "auto";
      store.put(book);
    }
    return undefined;
  });
}

export async function getOfflineContentStatus(id: number, version: string): Promise<OfflineContentStatus> {
  return transaction(["books", "chapters", "pages", "chunks"], "readonly", async (tx) => {
    const book = await readBook(tx, id);
    if (!book || book.contentVersion !== version) return { hasContent: false, chapterCount: 0, pageCount: 0, legacyFile: false };
    const range = IDBKeyRange.only([id, version]);
    const chapterCount = await trustedChapterCount(tx.objectStore("chapters").index("bookVersion"), range);
    const pageCount = await cursorCount(tx.objectStore("pages").index("bookVersion"), range);
    const legacyFile = (await cursorCount(tx.objectStore("chunks").index("bookVersion"), range)) > 0;
    return {
      // Resources by themselves are not a readable unit. A chapter or page
      // body (or an explicitly committed legacy file) is the cache boundary.
      // A legacy full-file marker is deliberately excluded. Only units
      // created by the online-first reader make a book available offline.
      hasContent: Boolean(chapterCount || pageCount),
      chapterCount,
      pageCount,
      legacyFile,
    };
  });
}

export async function hasOfflineBooks(): Promise<boolean> {
  return (await getOfflineBooks()).length > 0;
}

export async function saveOfflineChapter(id: number, version: string, idx: number, encoding: string, value: { title: string; content: string }, parserVersion = TXT_PARSER_VERSION): Promise<void> {
  if (storageFrozen) return;
  const normalized = normalizeEncoding(encoding);
  const parser = normalizeParserVersion(parserVersion);
  await transaction(["books", "chapters"], "readwrite", async (tx) => {
    const bookStore = tx.objectStore("books");
    const book = await readBook(tx, id);
    const chapters = tx.objectStore("chapters");
    const key = chapterKey(id, version, idx, normalized, parser);
    const existing = await request(chapters.get(key));
    chapters.put({
      key,
      bookId: id,
      contentVersion: version,
      idx,
      encoding: normalized,
      parserVersion: parser,
      title: value.title,
      content: value.content,
      cachedAt: Date.now(),
    } satisfies CachedChapter);
    if (book?.contentVersion === version) {
      book.hasCachedContent = true;
      if (!existing) book.cachedUnits = (book.cachedUnits ?? 0) + 1;
      book.summary = { ...book.summary, cached_content: true } as BookSummary;
      bookStore.put(book);
    }
    return undefined;
  });
}

export async function getOfflineChapter(id: number, version: string, idx: number, encoding = "", parserVersion = TXT_PARSER_VERSION): Promise<{ title: string; content: string } | null> {
  return transaction(["chapters"], "readonly", async (tx) => {
    const store = tx.objectStore("chapters");
    const normalized = normalizeEncoding(encoding);
    const parser = normalizeParserVersion(parserVersion);
    const current = (await request(store.get(chapterKey(id, version, idx, normalized, parser)))) as CachedChapter | undefined;
    return current && isTrustedChapter(current)
      ? { title: current.title, content: current.content }
      : null;
  });
}

export async function getOfflineChapterIndices(id: number, version: string, encoding = "", parserVersion = TXT_PARSER_VERSION): Promise<number[]> {
  return transaction(["chapters"], "readonly", async (tx) => {
    const normalized = normalizeEncoding(encoding);
    const parser = normalizeParserVersion(parserVersion);
    const chapters = await cursorMap<CachedChapter, number>(
      tx.objectStore("chapters").index("bookVersion"),
      (chapter) => chapter.encoding === normalized && chapter.parserVersion === parser ? chapter.idx : null,
      IDBKeyRange.only([id, version]),
    );
    return chapters.sort((a, b) => a - b);
  });
}

export async function saveOfflinePage(id: number, version: string, idx: number, data: Blob, name = String(idx), mime = data.type || "application/octet-stream"): Promise<void> {
  if (storageFrozen) return;
  await transaction(["books", "pages"], "readwrite", async (tx) => {
    const book = await readBook(tx, id);
    const pages = tx.objectStore("pages");
    const key = pageKey(id, version, idx);
    const existing = await request(pages.get(key));
    pages.put({ key, bookId: id, contentVersion: version, idx, name, mime, data, cachedAt: Date.now() } satisfies CachedPage);
    if (book?.contentVersion === version) {
      book.hasCachedContent = true;
      if (!existing) book.cachedPages = (book.cachedPages ?? 0) + 1;
      book.summary = { ...book.summary, cached_content: true } as BookSummary;
      tx.objectStore("books").put(book);
    }
    return undefined;
  });
}

export async function getOfflinePage(id: number, version: string, idx: number): Promise<CachedPage | null> {
  return transaction(["pages"], "readonly", async (tx) => (await request(tx.objectStore("pages").get(pageKey(id, version, idx)))) as CachedPage | null);
}

export async function getOfflinePages(id: number, version: string): Promise<Array<Pick<CachedPage, "idx" | "name" | "mime">>> {
  return transaction(["pages"], "readonly", async (tx) => {
    const pages = await cursorMap<CachedPage, Pick<CachedPage, "idx" | "name" | "mime">>(
      tx.objectStore("pages").index("bookVersion"),
      ({ idx, name, mime }) => ({ idx, name, mime }),
      IDBKeyRange.only([id, version]),
    );
    return pages.sort((a, b) => a.idx - b.idx);
  });
}

function resourceKey(bookId: number, version: string, path: string): string {
  return `${bookId}:${version}:resource:${encodeURIComponent(path)}`;
}

export async function saveOfflineResource(id: number, version: string, path: string, data: Blob, mime = data.type || "application/octet-stream", sourcePath?: string): Promise<void> {
  if (storageFrozen) return;
  await transaction(["resources"], "readwrite", async (tx) => {
    tx.objectStore("resources").put({ key: resourceKey(id, version, path), bookId: id, contentVersion: version, path, sourcePath, mime, data, cachedAt: Date.now() } satisfies CachedResource);
    return undefined;
  });
}

export async function getOfflineResource(id: number, version: string, path: string): Promise<CachedResource | null> {
  return transaction(["resources"], "readonly", async (tx) => {
    const store = tx.objectStore("resources");
    const direct = (await request(store.get(resourceKey(id, version, path)))) as CachedResource | undefined;
    if (direct) return direct;
    // Foliate's online ZIP loader stores resources by archive path, while the
    // server-rendered chapter refers to the numeric resource index. Resolve
    // both forms through the indexed source path without reading unrelated
    // binary records into memory.
    if (!store.indexNames.contains("bookVersionSourcePath")) return null;
    return (await request(
      store.index("bookVersionSourcePath").get(IDBKeyRange.only([id, version, path])),
    )) as CachedResource | null;
  });
}

/** Legacy full-file reader kept for old callers; the new reader never writes it. */
export async function getOfflineFile(id: number, version: string): Promise<Blob | null> {
  return transaction(["chunks"], "readonly", async (tx) => {
    const chunks = await cursorValues<StoredChunk>(tx.objectStore("chunks").index("bookVersion"), IDBKeyRange.only([id, version]));
    chunks.sort((a, b) => a.index - b.index);
    return chunks.length ? new Blob(chunks.map((chunk) => chunk.data)) : null;
  });
}

async function deleteByBook(tx: IDBTransaction, storeName: string, bookId: number): Promise<void> {
  const store = tx.objectStore(storeName);
  // All binary/unit stores carry the compound book/version index. Restrict
  // cleanup to this book so a large cache is never traversed or materialized
  // as a whole. The queue index is single-key and is handled the same way.
  const indexName = store.indexNames.contains("bookVersion")
    ? "bookVersion"
    : store.indexNames.contains("bookId")
      ? "bookId"
      : null;
  const source: IDBObjectStore | IDBIndex = indexName ? store.index(indexName) : store;
  const range = indexName === "bookVersion"
    ? IDBKeyRange.bound([bookId, ""], [bookId, "\uffff"])
    : indexName === "bookId"
      ? IDBKeyRange.only(bookId)
      : undefined;
  const cursor = source.openCursor(range);
  await new Promise<void>((resolve, reject) => {
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) {
        resolve();
        return;
      }
      // An index cursor's delete operation removes the underlying record and
      // avoids copying unrelated binary payloads into JavaScript. Databases
      // created by an early development build may lack the index, so retain a
      // guarded fallback for those records.
      if (indexName || (entry.value as { bookId?: number }).bookId === bookId) {
        entry.delete();
      }
      entry.continue();
    };
    cursor.onerror = () => reject(cursor.error ?? new Error("IndexedDB cleanup failed"));
  });
}

/** Replace only the latest operation for one content/decoder context. */
async function deleteQueuedContext(
  tx: IDBTransaction,
  bookId: number,
  contentVersion: string,
  encoding?: string,
): Promise<void> {
  const store = tx.objectStore("queue");
  const source: IDBObjectStore | IDBIndex = store.indexNames.contains("bookId")
    ? store.index("bookId")
    : store;
  const range = source === store ? undefined : IDBKeyRange.only(bookId);
  const cursor = source.openCursor(range);
  await new Promise<void>((resolve, reject) => {
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) {
        resolve();
        return;
      }
      const operation = entry.value as PendingProgress;
      if (
        operation.bookId === bookId
        && operation.contentVersion === contentVersion
        && normalizeEncoding(operation.value.encoding) === normalizeEncoding(encoding)
      ) {
        entry.delete();
      }
      entry.continue();
    };
    cursor.onerror = () => reject(cursor.error ?? new Error("IndexedDB queue update failed"));
  });
}

/** Remove cached reading units while retaining progress and its sync queue. */
export async function clearOfflineBookContent(id: number): Promise<void> {
  if (storageFrozen) return;
  await transaction(["books", "staged", "chunks", "chapters", "pages", "resources"], "readwrite", async (tx) => {
    await deleteByBook(tx, "staged", id);
    await deleteByBook(tx, "chunks", id);
    await deleteByBook(tx, "chapters", id);
    await deleteByBook(tx, "pages", id);
    await deleteByBook(tx, "resources", id);
    const book = await readBook(tx, id);
    if (book) {
      book.hasCachedContent = false;
      book.cachedUnits = 0;
      book.cachedPages = 0;
      book.complete = false;
      book.cover = undefined;
      delete book.summary.cached_content;
      tx.objectStore("books").put(book);
    }
    return undefined;
  });
  announceStorageEvent("cleared");
}

/** Compatibility name. It now clears content only, preserving progress. */
export async function deleteOfflineBook(id: number): Promise<void> {
  await clearOfflineBookContent(id);
}

function normalizedProgress(value: ProgressBody): ProgressBody {
  const encoding = value.encoding?.trim().toLowerCase();
  return encoding ? { ...value, encoding } : { ...value, encoding: undefined };
}

export function progressMatchesEncoding(value: ProgressBody | undefined, expectedEncoding?: string): boolean {
  if (!value) return false;
  if (expectedEncoding === undefined) return !value.encoding;
  return normalizeEncoding(value.encoding) === normalizeEncoding(expectedEncoding);
}

export async function saveLocalProgress(id: number, version: string, value: ProgressBody): Promise<void> {
  if (storageFrozen) return;
  await transaction(["progressByContext", "progress", "books"], "readwrite", async (tx) => {
    const normalized = normalizedProgress(value);
    const progressStore = tx.objectStore("progressByContext");
    const key = progressKey(id, version, normalized.encoding);
    const previous = (await request(progressStore.get(key))) as StoredProgressContext | undefined;
    progressStore.put({ key, bookId: id, contentVersion: version, value: normalized, encoding: normalized.encoding, updatedAt: Date.now(), localSequence: (previous?.localSequence ?? 0) + 1 } satisfies StoredProgressContext);
    const book = await readBook(tx, id);
    if (book?.contentVersion === version) {
      book.summary = { ...book.summary, percent: normalized.percent };
      const progress = { ...normalized, content_version: version };
      const key = detailKey(book.summary.format, normalized.encoding);
      const detail = { ...(book.details?.[key] ?? book.detail), progress };
      book.detail = detail;
      book.details = { ...(book.details ?? {}), [key]: detail };
      tx.objectStore("books").put(book);
    }
    return undefined;
  });
}

/** Persist the new position and its one-per-context sync operation atomically. */
export async function saveProgressAndEnqueue(id: number, version: string, value: ProgressBody, baseRevision: number): Promise<PendingProgress> {
  if (storageFrozen) {
    return { key: `${id}:frozen`, bookId: id, contentVersion: version, value, baseRevision, operationId: "frozen", createdAt: Date.now(), localSequence: 0 };
  }
  return transaction(["progressByContext", "progress", "books", "queue"], "readwrite", async (tx) => {
    const normalized = normalizedProgress(value);
    const progressStore = tx.objectStore("progressByContext");
    const key = progressKey(id, version, normalized.encoding);
    const previous = (await request(progressStore.get(key))) as StoredProgressContext | undefined;
    const localSequence = (previous?.localSequence ?? 0) + 1;
    progressStore.put({ key, bookId: id, contentVersion: version, value: normalized, encoding: normalized.encoding, updatedAt: Date.now(), localSequence } satisfies StoredProgressContext);
    const book = await readBook(tx, id);
    if (book?.contentVersion === version) {
      book.summary = { ...book.summary, percent: normalized.percent };
      const progress = { ...normalized, content_version: version };
      const key = detailKey(book.summary.format, normalized.encoding);
      const detail = { ...(book.details?.[key] ?? book.detail), progress };
      book.detail = detail;
      book.details = { ...(book.details ?? {}), [key]: detail };
      tx.objectStore("books").put(book);
    }
    await deleteQueuedContext(tx, id, version, value.encoding);
    const operation: PendingProgress = {
      key: `${id}:${randomId()}`,
      bookId: id,
      contentVersion: version,
      value: normalized,
      baseRevision,
      operationId: randomId(),
      createdAt: Date.now(),
      localSequence,
    };
    tx.objectStore("queue").put(operation);
    return operation;
  });
}

export async function getLocalProgress(id: number, version: string, encoding?: string): Promise<ProgressBody | null> {
  return transaction(["progressByContext", "progress"], "readonly", async (tx) => {
    const expected = normalizeEncoding(encoding);
    const context = (await request(tx.objectStore("progressByContext").get(progressKey(id, version, encoding)))) as StoredProgressContext | undefined;
    if (context && context.contentVersion === version && normalizeEncoding(context.encoding ?? context.value.encoding) === expected) {
      return context.value;
    }
    // Progress created by the previous schema is retained as a compatibility
    // fallback. It is only used when its content version and decoder match;
    // the next local write moves the position into the context store.
    const legacy = (await request(tx.objectStore("progress").get(id))) as StoredProgress | undefined;
    if (!legacy || legacy.contentVersion !== version) return null;
    return normalizeEncoding(legacy.encoding ?? legacy.value.encoding) === expected ? legacy.value : null;
  });
}

export async function enqueueProgress(id: number, version: string, value: ProgressBody, baseRevision: number): Promise<PendingProgress> {
  return transaction(["queue"], "readwrite", async (tx) => {
    await deleteQueuedContext(tx, id, version, value.encoding);
    const operation: PendingProgress = { key: `${id}:${randomId()}`, bookId: id, contentVersion: version, value: normalizedProgress(value), baseRevision, operationId: randomId(), createdAt: Date.now(), localSequence: 0 };
    tx.objectStore("queue").put(operation);
    return operation;
  });
}

/** Apply a response only when it still belongs to the current queued write. */
export async function acknowledgeProgress(operation: PendingProgress, value: ProgressBody, revision: number): Promise<boolean> {
  if (storageFrozen) return false;
  return transaction(["queue", "progressByContext", "progress", "books"], "readwrite", async (tx) => {
    const queue = tx.objectStore("queue");
    const current = (await request(queue.get(operation.key))) as PendingProgress | undefined;
    if (!current || current.operationId !== operation.operationId) {
      // The response belongs to an older operation that was replaced locally
      // while it was in flight. The server revision is still a valid base for
      // the newer queued write, so advance it without touching that write's
      // position or operation id.
      const cursor = queue.index("bookId").openCursor(IDBKeyRange.only(operation.bookId));
      await new Promise<void>((resolve, reject) => {
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) {
            resolve();
            return;
          }
          const queued = entry.value as PendingProgress;
          if (
            queued.contentVersion === operation.contentVersion
            && normalizeEncoding(queued.value.encoding) === normalizeEncoding(operation.value.encoding)
            && queued.baseRevision < revision
          ) {
            queued.baseRevision = revision;
            entry.update(queued);
          }
          entry.continue();
        };
        cursor.onerror = () => reject(cursor.error ?? new Error("IndexedDB queue update failed"));
      });
      return false;
    }
    const normalized = { ...normalizedProgress(value), revision, content_version: operation.contentVersion };
    const key = progressKey(operation.bookId, operation.contentVersion, normalized.encoding);
    tx.objectStore("progressByContext").put({ key, bookId: operation.bookId, contentVersion: operation.contentVersion, value: normalized, encoding: normalized.encoding, updatedAt: Date.now(), localSequence: current.localSequence } satisfies StoredProgressContext);
    const book = await readBook(tx, operation.bookId);
    if (book?.contentVersion === operation.contentVersion) {
      book.summary = { ...book.summary, percent: normalized.percent };
      const key = detailKey(book.summary.format, normalized.encoding);
      const detail = { ...(book.details?.[key] ?? book.detail), progress: normalized };
      book.detail = detail;
      book.details = { ...(book.details ?? {}), [key]: detail };
      tx.objectStore("books").put(book);
    }
    queue.delete(operation.key);
    return true;
  });
}

export async function listPendingProgress(): Promise<PendingProgress[]> {
  return transaction(["queue"], "readonly", async (tx) => {
    const values = await cursorValues<PendingProgress>(tx.objectStore("queue"));
    return values.sort((a, b) => a.createdAt - b.createdAt || a.localSequence - b.localSequence);
  });
}

export async function removePendingProgress(key: string): Promise<void> {
  await transaction(["queue"], "readwrite", async (tx) => {
    tx.objectStore("queue").delete(key);
    return undefined;
  });
}

export async function clearOfflineData(): Promise<void> {
  const names = ["books", "staged", "chunks", "chapters", "pages", "resources", "progress", "progressByContext", "queue"];
  await transaction(names, "readwrite", async (tx) => {
    names.forEach((name) => tx.objectStore(name).clear());
    return undefined;
  });
  announceStorageEvent("cleared");
}
