export type ReaderNavigationItem = {
  id: string;
  label: string;
  depth?: number;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
};

export type ReaderNavigationRequest = {
  id: string;
  token: number;
};

/** Clamp a scrubber value to a real entry in a chapter or page list. */
export function navigationScrubIndex(count: number, value: number): number {
  if (count <= 1) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(value)));
}

/** Scroll offset that places an item in the middle of a scrollable list. */
export function navigationListScrollTop(currentScroll: number, listHeight: number, itemOffset: number, itemHeight: number): number {
  if (listHeight <= 0) return Math.max(0, currentScroll);
  return Math.max(0, currentScroll + itemOffset - listHeight / 2 + itemHeight / 2);
}
