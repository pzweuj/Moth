import {
  BlobWriter,
  HttpRangeReader,
  TextWriter,
  ZipReader,
  configure,
  type FileEntry,
} from "@zip.js/zip.js";

/** Loader interface consumed by foliate-js `epub.js` and `comic-book.js`. */
export interface ZipLoader {
  entries: { filename: string }[];
  loadText(filename: string): Promise<string | null>;
  loadBlob(filename: string, type?: string): Promise<Blob | null>;
  getSize(filename: string): number;
}

/**
 * Build a zip.js loader that reads a remote archive over HTTP Range requests,
 * fetching only the entries that are actually needed. The server serves the
 * book file with `Accept-Ranges: bytes` and `206` responses.
 */
export async function makeRangeLoader(url: string): Promise<ZipLoader> {
  configure({ useWebWorkers: false });
  const reader = new ZipReader(new HttpRangeReader(url));
  const entries = await reader.getEntries();
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
      return entry ? entry.getData(new BlobWriter(type)) : null;
    },
    getSize: (name) => byName.get(name)?.uncompressedSize ?? 0,
  };
}
