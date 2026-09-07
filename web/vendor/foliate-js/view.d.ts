// Ambient types for the vendored foliate-js modules. These are additive
// declarations (see web/vendor/README.md); they do not change upstream code.

export type FoliateBook = Record<string, unknown>;

export interface FoliateRenderer {
  goTo(location: unknown): Promise<unknown>;
  prev(distance?: number): Promise<void>;
  next(distance?: number): Promise<void>;
  open(book: FoliateBook): Promise<void>;
  destroy(): void;
  setStyles(css: string): void;
  setAttribute(name: string, value: string): void;
  getContents(): { doc: Document; index: number; overlayer?: unknown }[];
  scrollToAnchor(range: Range, smooth?: boolean): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  [key: string]: unknown;
}

export interface FoliateViewElement extends HTMLElement {
  open(book: FoliateBook | string): Promise<void>;
  close(): void;
  init(options: { lastLocation?: unknown; showTextStart?: boolean }): Promise<void>;
  next(distance?: number): Promise<void>;
  prev(distance?: number): Promise<void>;
  goTo(target: unknown): Promise<unknown>;
  resolveNavigation(target: unknown): unknown;
  goToFraction(fraction: number): Promise<void>;
  goLeft(): void;
  goRight(): void;
  getSectionFractions(): number[];
  book: FoliateBook;
  renderer: FoliateRenderer;
  lastLocation: {
    cfi?: unknown;
    fraction?: number;
    section?: { current: number; total: number };
    location?: { current: number; next: number; total: number };
    range?: Range;
  } | null;
  [key: string]: unknown;
}

export function makeBook(file: string | Blob | File | FoliateBook): Promise<FoliateBook>;
export class ResponseError extends Error {}
export class NotFoundError extends Error {}
export class UnsupportedTypeError extends Error {}
