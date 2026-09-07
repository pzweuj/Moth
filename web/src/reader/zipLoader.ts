import {
  BlobWriter,
  BlobReader,
  HttpRangeReader,
  TextWriter,
  ZipReader,
  configure,
  type FileEntry,
} from "@zip.js/zip.js";
import { fetchWithTimeout } from "../api";

/** Loader interface consumed by foliate-js `epub.js` and `comic-book.js`. */
export interface ZipLoader {
  entries: { filename: string }[];
  loadText(filename: string): Promise<string | null>;
  loadBlob(filename: string, type?: string): Promise<Blob | null>;
  getSize(filename: string): number;
  close(): Promise<void>;
}

/**
 * Build a zip.js loader that reads a remote archive over HTTP Range requests,
 * fetching only the entries that are actually needed. The server serves the
 * book file with `Accept-Ranges: bytes` and `206` responses.
 */
export async function makeRangeLoader(
  url: string,
  offlineBlob?: Blob,
  signal?: AbortSignal,
  contentVersion?: string,
  onBlob?: (filename: string, blob: Blob) => void,
): Promise<ZipLoader> {
  configure({ useWebWorkers: false });
  const reader = new ZipReader(
    offlineBlob
      ? new BlobReader(offlineBlob)
      : new HttpRangeReader(url, {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          if (contentVersion) headers.set("If-Match", `"${contentVersion}"`);
          return fetchWithTimeout(input, { ...init, headers, signal, credentials: "same-origin" });
        },
      }),
  );
  let entries: Awaited<ReturnType<typeof reader.getEntries>>;
  try {
    entries = await reader.getEntries();
  } catch (error) {
    await reader.close().catch(() => undefined);
    throw error;
  }
  const byName = new Map<string, FileEntry>();
  for (const entry of entries) {
    if (entry.directory) continue;
    byName.set(entry.filename, entry);
  }
  return {
    entries,
    loadText: async (name) => {
      const entry = byName.get(name);
      return entry ? entry.getData(new TextWriter()) : null;
    },
    loadBlob: async (name, type) => {
      const entry = byName.get(name);
      if (!entry) return null;
      const blob = await entry.getData(new BlobWriter(type));
      onBlob?.(name, blob);
      return blob;
    },
    getSize: (name) => byName.get(name)?.uncompressedSize ?? 0,
    close: () => reader.close(),
  };
}
