// Ambient types for the vendored foliate-js epub module.

export interface ZipLoaderLike {
  entries?: { filename: string }[];
  loadText(filename: string): Promise<string | null>;
  loadBlob(filename: string, type?: string): Promise<Blob | null>;
  getSize(filename: string): number;
}

export type EpubResourceLoadOptions = { speculative?: boolean };
export type EpubOptions = { resourceBudget?: number };

export type FoliateBook = Record<string, unknown>;

export class EPUB {
  constructor(loader: ZipLoaderLike, options?: EpubOptions);
  init(): Promise<EPUB>;
  readonly resourceBytes: number;
  readonly resourceBudget: number;
  sections: Array<{ load(options?: EpubResourceLoadOptions): Promise<string | null>; unload(): void; linear?: string }>;
  rendition?: { layout?: string; spread?: string; autoSpread?: boolean; viewport?: unknown };
  destroy(): void;
}
