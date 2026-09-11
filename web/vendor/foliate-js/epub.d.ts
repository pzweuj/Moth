// Ambient types for the vendored foliate-js epub module.

export interface ZipLoaderLike {
  entries?: { filename: string }[];
  loadText(filename: string): Promise<string | null>;
  loadBlob(filename: string, type?: string): Promise<Blob | null>;
  getSize(filename: string): number;
}

export type FoliateBook = Record<string, unknown>;

export class EPUB {
  constructor(loader: ZipLoaderLike);
  init(): Promise<EPUB>;
  sections: Array<{ load(): Promise<string | null>; unload(): void; linear?: string }>;
  rendition?: { layout?: string; spread?: string; autoSpread?: boolean; viewport?: unknown };
  destroy(): void;
}
