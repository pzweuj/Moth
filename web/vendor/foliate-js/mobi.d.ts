// Ambient types for the vendored foliate-js mobi module.

export type FoliateBook = Record<string, unknown>;

export class MOBI {
  constructor(options: { unzlib: (data: Uint8Array) => Uint8Array });
  open(file: File | Blob): Promise<FoliateBook>;
}

export function isMOBI(file: File | Blob): Promise<boolean>;
