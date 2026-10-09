export type PageFrame = {
  width?: number;
  height?: number;
};

export type PageThumbnailBox = {
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  imageHeight: number;
  cropped: boolean;
};

export type PageThumbnailLayout = {
  totalHeight: number;
  boxes: PageThumbnailBox[];
};

const FALLBACK_RATIO = 2 / 3;
const MAX_IMAGE_HEIGHT = 420;

type LayoutOptions = {
  columns?: number;
  gap?: number;
  padding?: number;
  caption?: number;
};

/** Place CBZ previews in rows that follow each page's own aspect ratio. */
export function layoutPageThumbnails(pages: PageFrame[], listWidth: number, options: LayoutOptions = {}): PageThumbnailLayout {
  const columns = Math.max(1, options.columns ?? 3);
  const gap = options.gap ?? 12;
  const padding = options.padding ?? 10;
  const caption = options.caption ?? 22;
  if (pages.length === 0 || listWidth <= padding * 2) {
    return { totalHeight: 0, boxes: [] };
  }
  const cellWidth = (listWidth - padding * 2 - gap * (columns - 1)) / columns;
  const boxes: PageThumbnailBox[] = [];
  let top = padding;
  for (let start = 0; start < pages.length; start += columns) {
    const row = [];
    for (let column = 0; column < columns && start + column < pages.length; column += 1) {
      const page = pages[start + column];
      const ratio = page.width && page.height && page.width > 0 && page.height > 0 ? page.width / page.height : FALLBACK_RATIO;
      let imageHeight = cellWidth / ratio;
      let cropped = false;
      if (imageHeight > MAX_IMAGE_HEIGHT) {
        imageHeight = MAX_IMAGE_HEIGHT;
        cropped = true;
      }
      row.push({ column, imageHeight, height: imageHeight + caption, cropped });
    }
    const rowHeight = row.reduce((tallest, cell) => Math.max(tallest, cell.height), 0);
    for (const cell of row) {
      boxes.push({
        index: start + cell.column,
        top,
        left: padding + cell.column * (cellWidth + gap),
        width: cellWidth,
        height: rowHeight,
        imageHeight: cell.imageHeight,
        cropped: cell.cropped,
      });
    }
    top += rowHeight + gap;
  }
  return { totalHeight: top - gap + padding, boxes };
}

/** Indexes whose boxes intersect the viewport, plus a buffer above and below. */
export function visibleThumbnailIndexes(boxes: PageThumbnailBox[], scrollTop: number, viewport: number, buffer: number): number[] {
  const start = scrollTop - buffer;
  const end = scrollTop + Math.max(0, viewport) + buffer;
  return boxes.filter((box) => box.top + box.height >= start && box.top <= end).map((box) => box.index);
}
