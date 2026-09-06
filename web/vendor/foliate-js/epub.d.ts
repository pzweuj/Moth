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
  init(): Promise<FoliateBook>;
}
