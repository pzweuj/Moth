import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { navigationListScrollTop, type ReaderNavigationItem } from "./navigation";
import { layoutPageThumbnails, visibleThumbnailIndexes } from "./pageThumbnails";

type Props = {
  items: ReaderNavigationItem[];
  activeId: string;
  previewId?: string;
  columns: number;
  onSelect: (item: ReaderNavigationItem) => void;
};

const BUFFER_PX = 800;

export function PageThumbnailGrid({ items, activeId, previewId = "", columns, onSelect }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const placed = useRef("");

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      setWidth(list.clientWidth);
      setViewport(list.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => layoutPageThumbnails(items, width, { columns }),
    [columns, items, width],
  );

  useLayoutEffect(() => {
    const list = listRef.current;
    const targetId = previewId || activeId;
    if (!list || !targetId || width <= 0 || viewport <= 0) return;
    if (!previewId && placed.current === activeId) return;
    const box = layout.boxes.find((entry) => items[entry.index]?.id === targetId);
    if (!box) return;
    const next = navigationListScrollTop(0, viewport, box.top, box.height);
    list.scrollTop = next;
    setScrollTop(next);
    if (!previewId) placed.current = activeId;
  }, [activeId, items, layout.boxes, previewId, viewport, width]);

  const visible = useMemo(() => {
    const indexes = new Set(visibleThumbnailIndexes(layout.boxes, scrollTop, viewport, BUFFER_PX));
    for (const id of [activeId, previewId]) {
      const index = items.findIndex((item) => item.id === id);
      if (index >= 0) indexes.add(index);
    }
    return layout.boxes.filter((box) => indexes.has(box.index));
  }, [activeId, items, layout.boxes, previewId, scrollTop, viewport]);

  return (
    <div
      className="reader-navigation-list"
      ref={listRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: layout.totalHeight, position: "relative" }}>
        {visible.map((box) => {
          const item = items[box.index];
          if (!item) return null;
          return (
            <button
              className={`reader-navigation-item ${item.id === activeId ? "is-active" : ""} ${item.id === previewId && item.id !== activeId ? "is-preview" : ""}`}
              style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
              type="button"
              key={item.id}
              onClick={() => onSelect(item)}
            >
              {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" decoding="async" height={box.imageHeight} className={box.cropped ? "is-cropped" : undefined} /> : null}
              <small>{item.label}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
