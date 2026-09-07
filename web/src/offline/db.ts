import type { BookDetail, BookSummary, ProgressBody } from "../api";

const DB_NAME = "moth-offline-v2";
const DB_VERSION = 1;
const CHUNK_SIZE = 256 * 1024;
const SCOPE_STORAGE_KEY = "moth:offline-scope";

/**
 * Keep each server origin and single-user account in its own IndexedDB
 * database. This prevents a book id from one self-hosted instance/account
 * being mistaken for the same book after switching accounts or origins.
 */
function databaseName(): string {
  let account = "";
  try {
    account = localStorage.getItem(SCOPE_STORAGE_KEY) ?? "";
  } catch {
    // Private browsing may deny localStorage; origin still provides isolation.
  }
  const origin = typeof location !== "undefined" ? location.origin : "unknown-origin";
  return `${DB_NAME}-${encodeURIComponent(`${origin}|${account || "anonymous"}`)}`;
}

export function setOfflineScope(username: string | null): void {
  try {
    if (username?.trim()) localStorage.setItem(SCOPE_STORAGE_KEY, username.trim());
    else localStorage.removeItem(SCOPE_STORAGE_KEY);
  } catch {
    // IndexedDB remains usable when localStorage is unavailable.
  }
}

type StoredBook = {
  id: number;
  summary: BookSummary;
  detail: BookDetail;
  cover?: Blob;
  txtEncoding?: string;
  contentVersion: string;
  /** Unique committed payload key. Older records fall back to contentVersion. */
  storageKey?: string;
  complete: boolean;
  downloadedAt: number;
};

type StagedBook = StoredBook & { key: string };

type StoredChunk = {
  key: string;
  bookId: number;
  contentVersion: string;
  storageKey?: string;
  index: number;
  data: ArrayBuffer;
};

type StoredChapter = {
  key: string;
  bookId: number;
  contentVersion: string;
  storageKey?: string;
  idx: number;
  encoding: string;
  title: string;
  content: string;
};

type StoredProgress = {
  bookId: number;
  value: ProgressBody;
  contentVersion: string;
  /** Normalized TXT decoder label (`auto` for scan-selected text). */
  encoding?: string;
  updatedAt: number;
};

export type PendingProgress = {
  key: string;
  bookId: number;
  contentVersion: string;
  value: ProgressBody;
  baseRevision: number;
  operationId: string;
  createdAt: number;
};

/**
 * TXT locations are meaningful only for the decoder that produced them.
 * Legacy records without a label are the scan-selected (`auto`) decoder.
 */
function progressEncoding(encoding?: string): string | undefined {
  if (encoding === undefined) return undefined;
  return encoding.trim().toLowerCase() || "auto";
}

export function progressMatchesEncoding(
  value: ProgressBody | undefined,
  expectedEncoding?: string,
): boolean {
  if (!value) return false;
  if (expectedEncoding === undefined) return !value.encoding;
  const expected = progressEncoding(expectedEncoding);
  const actual = value.encoding?.trim().toLowerCase() || "auto";
  return actual === expected;
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName(), DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
      if (!db.objectStoreNames.contains("staged")) db.createObjectStore("staged", { keyPath: "key" });
      if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { keyPath: "key" });
      if (!db.objectStoreNames.contains("chapters")) db.createObjectStore("chapters", { keyPath: "key" });
      if (!db.objectStoreNames.contains("progress")) db.createObjectStore("progress", { keyPath: "bookId" });
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "key" });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("Could not open offline storage"));
  });
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await database();
  const tx = db.transaction(stores, mode);
  try {
    const result = await run(tx);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
    return result;
  } finally {
    db.close();
  }
}

function legacyChapterKey(bookId: number, version: string, idx: number, encoding: string): string {
  return `${bookId}:${version}:${encoding || "auto"}:${idx}`;
}

function chapterKey(storageKey: string, idx: number, encoding: string): string {
  return `${storageKey}:chapter:${encoding || "auto"}:${idx}`;
}

function chunkKey(storageKey: string, index: number): string {
  return `${storageKey}:chunk:${index}`;
}

function makeStorageKey(bookId: number, version: string): string {
  return `${bookId}:${version}:${randomId()}`;
}

function randomId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function committedStorageKey(book: StoredBook): string {
  return book.storageKey ?? `${book.id}:${book.contentVersion}`;
}

export async function getOfflineBooks(): Promise<BookSummary[]> {
  return transaction(["books"], "readonly", async (tx) => {
    const books = (await request(tx.objectStore("books").getAll())) as StoredBook[];
    return books.filter((book) => book.complete).map((book) => book.summary);
  });
}

export async function getOfflineBook(id: number): Promise<BookDetail | null> {
  return transaction(["books"], "readonly", async (tx) => {
    const book = (await request(tx.objectStore("books").get(id))) as StoredBook | undefined;
    return book?.complete ? book.detail : null;
  });
}

export async function getOfflineCover(id: number, version: string): Promise<Blob | null> {
  return transaction(["books"], "readonly", async (tx) => {
    const book = (await request(tx.objectStore("books").get(id))) as StoredBook | undefined;
    if (!book?.complete || book.contentVersion !== version || !book.cover) return null;
    return book.cover;
  });
}

export async function getOfflineTxtEncoding(id: number, version: string): Promise<string> {
  return transaction(["books"], "readonly", async (tx) => {
    const book = (await request(tx.objectStore("books").get(id))) as StoredBook | undefined;
    return book?.complete && book.contentVersion === version ? book.txtEncoding ?? "auto" : "";
  });
}

export async function setOfflineTxtEncoding(id: number, version: string, encoding: string): Promise<void> {
  await transaction(["books"], "readwrite", async (tx) => {
    const store = tx.objectStore("books");
    const book = (await request(store.get(id))) as StoredBook | undefined;
    if (book?.complete && book.contentVersion === version) {
      book.txtEncoding = encoding || "auto";
      store.put(book);
    }
    return undefined;
  });
}

export async function hasOfflineBooks(): Promise<boolean> {
  return (await getOfflineBooks()).length > 0;
}

export async function downloadBook(
  summary: BookSummary,
  detail: BookDetail,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void,
  encoding = "",
): Promise<void> {
  const version = summary.content_version;
  if (detail.content_version !== version) {
    throw new Error("The book changed while it was being prepared. Refresh and try again.");
  }
  const storageKey = makeStorageKey(summary.id, version);
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      if (estimate.quota != null && estimate.usage != null) {
        const renderedTextSize = detail.chapters.reduce((total, chapter) => total + chapter.size, 0);
        const required = Math.ceil(Math.max(summary.file_size, renderedTextSize) * 1.15);
        if (required > Math.max(0, estimate.quota - estimate.usage)) {
          throw new Error("Not enough device storage. Remove an offline book and try again.");
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Not enough device storage")) throw error;
      // Browsers may deny storage estimates; the IndexedDB write remains the source of truth.
    }
  }
  try {
    await transaction(["staged", "chunks", "chapters"], "readwrite", async (tx) => {
    const staged = tx.objectStore("staged");
    staged.put({
      key: storageKey,
      id: summary.id,
      summary,
      detail,
      contentVersion: version,
      storageKey,
      complete: false,
      txtEncoding: summary.format === "txt" ? encoding || "auto" : undefined,
      downloadedAt: Date.now(),
    } satisfies StagedBook);
    // Remove abandoned staging records for this book/version while leaving a
    // previously committed payload untouched until the new one is complete.
    const stagedRecords = (await request(staged.getAll())) as StagedBook[];
    const staleKeys = stagedRecords
      .filter((record) => record.id === summary.id && record.contentVersion === version && record.key !== storageKey)
      .map((record) => record.key);
    staleKeys.forEach((key) => staged.delete(key));
    for (const storeName of ["chunks", "chapters"] as const) {
      const store = tx.objectStore(storeName);
      const records = (await request(store.getAll())) as Array<{ key: string; bookId: number; storageKey?: string }>;
      records
        .filter((record) => record.bookId === summary.id && record.storageKey && staleKeys.includes(record.storageKey))
        .forEach((record) => store.delete(record.key));
    }
    return undefined;
    });
    let cover: Blob | undefined;
    if (summary.has_cover && summary.cover_url) {
      const response = await fetch(summary.cover_url, {
        credentials: "same-origin",
        headers: { "If-Match": `"${version}"` },
        signal,
      });
      if (!response.ok) throw new Error(`Cover download failed (${response.status})`);
      if (response.headers.get("etag")?.trim() !== `"${version}"`) {
        throw new Error("The book changed while it was being prepared. Refresh and try again.");
      }
      cover = await response.blob();
    }
    await transaction(["staged"], "readwrite", async (tx) => {
      const store = tx.objectStore("staged");
      const staged = (await request(store.get(storageKey))) as StagedBook | undefined;
      if (!staged) throw new Error("Offline download staging record is missing");
      staged.cover = cover;
      store.put(staged);
      return undefined;
    });
    if (summary.format === "txt") {
      for (const [index, chapter] of detail.chapters.entries()) {
        if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
        const query = encoding ? `?encoding=${encodeURIComponent(encoding)}` : "";
        const response = await fetch(`/api/v1/books/${summary.id}/chapter/${chapter.idx}${query}`, {
          credentials: "same-origin",
          headers: { "If-Match": `"${version}"` },
          signal,
        });
        if (!response.ok) throw new Error(`Chapter download failed (${response.status})`);
        if (response.headers.get("etag")?.trim() !== `"${version}"`) {
          throw new Error("The book changed while it was being prepared. Refresh and try again.");
        }
        const value = (await response.json()) as { title: string; content: string };
        await transaction(["chapters"], "readwrite", async (tx) => {
          tx.objectStore("chapters").put({
            key: chapterKey(storageKey, chapter.idx, encoding),
            bookId: summary.id,
            contentVersion: version,
            storageKey,
            idx: chapter.idx,
            encoding,
            title: value.title,
            content: value.content,
          } satisfies StoredChapter);
          return undefined;
        });
        onProgress?.(((index + 1) / Math.max(detail.chapters.length, 1)) * 100);
      }
    } else {
      const response = await fetch(`/api/v1/books/${summary.id}/file`, {
        credentials: "same-origin",
        headers: { "If-Match": `"${version}"` },
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`Book download failed (${response.status})`);
      if (response.headers.get("etag")?.trim() !== `"${version}"`) {
        throw new Error("The book changed while it was downloading. Refresh and try again.");
      }
      const reader = response.body.getReader();
      let index = 0;
      let received = 0;
      const total = Number(response.headers.get("content-length") || summary.file_size || 0);
      let pending = new Uint8Array(0);
      while (true) {
        if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
        const next = await reader.read();
        if (next.done) break;
        const merged = new Uint8Array(pending.length + next.value.length);
        merged.set(pending);
        merged.set(next.value, pending.length);
        let offset = 0;
        while (merged.length - offset >= CHUNK_SIZE) {
          const chunk = merged.slice(offset, offset + CHUNK_SIZE);
          await storeChunk(summary.id, version, storageKey, index++, chunk);
          offset += CHUNK_SIZE;
          received += CHUNK_SIZE;
          onProgress?.(total ? (received / total) * 100 : 0);
        }
        pending = merged.slice(offset);
      }
      if (pending.length) {
        await storeChunk(summary.id, version, storageKey, index++, pending);
        received += pending.length;
        onProgress?.(total ? (received / total) * 100 : 100);
      }
      if (total > 0 && received !== total) {
        throw new Error("The book download ended before all bytes arrived. Try again.");
      }
    }
    if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");
    await transaction(["books", "staged", "chunks", "chapters"], "readwrite", async (tx) => {
      const books = tx.objectStore("books");
      const staged = (await request(tx.objectStore("staged").get(storageKey))) as StagedBook | undefined;
      if (!staged) throw new Error("Offline download staging record is missing");
      const book: StoredBook = {
        id: staged.id,
        summary: staged.summary,
        detail: staged.detail,
        cover: staged.cover,
        txtEncoding: staged.txtEncoding,
        contentVersion: staged.contentVersion,
        storageKey: staged.storageKey,
        complete: staged.complete,
        downloadedAt: staged.downloadedAt,
      };
      book.complete = true;
      book.downloadedAt = Date.now();
      books.put(book satisfies StoredBook);
      tx.objectStore("staged").delete(staged.key);
      for (const storeName of ["chunks", "chapters"] as const) {
        const store = tx.objectStore(storeName);
        const records = (await request(store.getAll())) as Array<{ key: string; bookId: number; contentVersion: string; storageKey?: string }>;
        records
          .filter((record) => record.bookId === summary.id && (record.contentVersion !== version || record.storageKey !== storageKey))
          .forEach((record) => store.delete(record.key));
      }
      return undefined;
    });
  } catch (error) {
    await discardStaged(summary.id, version, storageKey);
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      throw new Error("Not enough device storage. Remove an offline book and try again.");
    }
    throw error;
  }
}

async function discardStaged(id: number, version: string, storageKey: string): Promise<void> {
  await transaction(["staged", "chunks", "chapters"], "readwrite", async (tx) => {
    tx.objectStore("staged").delete(storageKey);
    for (const storeName of ["chunks", "chapters"] as const) {
      const store = tx.objectStore(storeName);
      const records = (await request(store.getAll())) as Array<{ key: string; bookId: number; contentVersion: string; storageKey?: string }>;
      records.filter((record) => record.bookId === id && record.contentVersion === version && record.storageKey === storageKey).forEach((record) => store.delete(record.key));
    }
    return undefined;
  });
}

async function storeChunk(bookId: number, version: string, storageKey: string, index: number, chunk: Uint8Array): Promise<void> {
  await transaction(["chunks"], "readwrite", async (tx) => {
    tx.objectStore("chunks").put({
      key: chunkKey(storageKey, index),
      bookId,
      contentVersion: version,
      storageKey,
      index,
      data: chunk.buffer,
    } satisfies StoredChunk);
    return undefined;
  });
}

export async function saveOfflineChapter(
  id: number,
  version: string,
  idx: number,
  encoding: string,
  value: { title: string; content: string },
): Promise<void> {
  await transaction(["books", "chapters"], "readwrite", async (tx) => {
    const book = (await request(tx.objectStore("books").get(id))) as StoredBook | undefined;
    const storageKey = book?.complete && book.contentVersion === version
      ? committedStorageKey(book)
      : `${id}:${version}`;
    tx.objectStore("chapters").put({
      key: book?.storageKey ? chapterKey(storageKey, idx, encoding) : legacyChapterKey(id, version, idx, encoding),
      bookId: id,
      contentVersion: version,
      storageKey: book?.storageKey,
      idx,
      encoding,
      title: value.title,
      content: value.content,
    } satisfies StoredChapter);
    return undefined;
  });
}

export async function getOfflineFile(id: number, version: string): Promise<Blob | null> {
  return transaction(["books", "chunks"], "readonly", async (tx) => {
    const book = (await request(tx.objectStore("books").get(id))) as StoredBook | undefined;
    if (!book?.complete || book.contentVersion !== version) return null;
    const storageKey = book.storageKey;
    const chunks = (await request(tx.objectStore("chunks").getAll())) as StoredChunk[];
    const selected = chunks
      .filter((chunk) => chunk.bookId === id && chunk.contentVersion === version && (storageKey ? chunk.storageKey === storageKey : !chunk.storageKey))
      .sort((a, b) => a.index - b.index)
      .map((chunk) => chunk.data);
    return selected.length ? new Blob(selected) : null;
  });
}

export async function getOfflineChapter(id: number, version: string, idx: number, encoding = ""): Promise<{ title: string; content: string } | null> {
  return transaction(["books", "chapters"], "readonly", async (tx) => {
    const book = (await request(tx.objectStore("books").get(id))) as StoredBook | undefined;
    if (!book?.complete || book.contentVersion !== version) return null;
    const key = book.storageKey
      ? chapterKey(committedStorageKey(book), idx, encoding)
      : legacyChapterKey(id, version, idx, encoding);
    const chapter = (await request(tx.objectStore("chapters").get(key))) as StoredChapter | undefined;
    return chapter ? { title: chapter.title, content: chapter.content } : null;
  });
}

export async function deleteOfflineBook(id: number): Promise<void> {
  await transaction(["books", "staged", "chunks", "chapters", "progress", "queue"], "readwrite", async (tx) => {
    const bookStore = tx.objectStore("books");
    bookStore.delete(id);
    const staged = (await request(tx.objectStore("staged").getAll())) as StagedBook[];
    staged.filter((record) => record.id === id).forEach((record) => tx.objectStore("staged").delete(record.key));
    for (const storeName of ["chunks", "chapters"] as const) {
      const store = tx.objectStore(storeName);
      const records = (await request(store.getAll())) as Array<{ key: string; bookId: number }>;
      records.filter((record) => record.bookId === id).forEach((record) => store.delete(record.key));
    }
    tx.objectStore("progress").delete(id);
    const queue = tx.objectStore("queue");
    const pending = (await request(queue.getAll())) as PendingProgress[];
    pending.filter((record) => record.bookId === id).forEach((record) => queue.delete(record.key));
    return undefined;
  });
}

export async function saveLocalProgress(id: number, version: string, value: ProgressBody): Promise<void> {
  await transaction(["progress", "books"], "readwrite", async (tx) => {
    const encoding = value.encoding?.trim().toLowerCase() || undefined;
    const normalized = encoding ? { ...value, encoding } : { ...value, encoding: undefined };
    tx.objectStore("progress").put({
      bookId: id,
      contentVersion: version,
      value: normalized,
      encoding,
      updatedAt: Date.now(),
    } satisfies StoredProgress);
    const bookStore = tx.objectStore("books");
    const book = (await request(bookStore.get(id))) as StoredBook | undefined;
    if (book?.complete && book.contentVersion === version) {
      book.summary = { ...book.summary, percent: value.percent };
      book.detail = {
        ...book.detail,
        progress: {
          ...normalized,
          content_version: version,
        },
      };
      bookStore.put(book);
    }
    return undefined;
  });
}

export async function getLocalProgress(
  id: number,
  version: string,
  encoding?: string,
): Promise<ProgressBody | null> {
  return transaction(["progress"], "readonly", async (tx) => {
    const record = (await request(tx.objectStore("progress").get(id))) as StoredProgress | undefined;
    if (!record || record.contentVersion !== version) return null;
    const value = record.value;
    if (encoding === undefined) {
      return !record.encoding && !value.encoding ? value : null;
    }
    const expected = encoding.trim().toLowerCase() || "auto";
    const actual = record.encoding?.trim().toLowerCase() || value.encoding?.trim().toLowerCase() || "auto";
    return actual === expected ? value : null;
  });
}

export async function enqueueProgress(
  id: number,
  version: string,
  value: ProgressBody,
  baseRevision: number,
): Promise<PendingProgress> {
  const operation: PendingProgress = {
    key: `${id}:${randomId()}`,
    bookId: id,
    contentVersion: version,
    value,
    baseRevision,
    operationId: randomId(),
    createdAt: Date.now(),
  };
  await transaction(["queue"], "readwrite", async (tx) => {
    const store = tx.objectStore("queue");
    const existing = (await request(store.getAll())) as PendingProgress[];
    existing.filter((item) => item.bookId === id).forEach((item) => store.delete(item.key));
    store.put(operation);
    return undefined;
  });
  return operation;
}

export async function listPendingProgress(): Promise<PendingProgress[]> {
  return transaction(["queue"], "readonly", async (tx) => request(tx.objectStore("queue").getAll()) as Promise<PendingProgress[]>);
}

export async function removePendingProgress(key: string): Promise<void> {
  await transaction(["queue"], "readwrite", async (tx) => {
    tx.objectStore("queue").delete(key);
    return undefined;
  });
}

export async function clearOfflineData(): Promise<void> {
  const db = await database();
  const tx = db.transaction(["books", "staged", "chunks", "chapters", "progress", "queue"], "readwrite");
  ["books", "staged", "chunks", "chapters", "progress", "queue"].forEach((name) => tx.objectStore(name).clear());
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not clear offline data"));
    tx.onabort = () => reject(tx.error ?? new Error("Could not clear offline data"));
  });
  db.close();
}
