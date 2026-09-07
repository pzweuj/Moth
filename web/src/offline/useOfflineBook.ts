import { useEffect, useRef, useState } from "react";
import type { BookSummary } from "../api";
import { clearOfflineBookContent, getOfflineContentStatus, getOfflineCover } from "./db";

export type OfflineBookState = "unknown" | "partial" | "none" | "error";

/**
 * Read-only cache status for a shelf card. Content is cached automatically by
 * the reader; there is intentionally no whole-book download action here.
 */
export function useOfflineBook(book: BookSummary): {
  state: OfflineBookState;
  chapterCount: number;
  pageCount: number;
  coverUrl?: string;
  refresh: () => void;
  clearCache: () => Promise<void>;
} {
  const [state, setState] = useState<OfflineBookState>("unknown");
  const [chapterCount, setChapterCount] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [coverUrl, setCoverUrl] = useState<string | undefined>(undefined);
  const [refreshToken, redraw] = useState(0);
  const coverUrlRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setState("unknown");
    if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current);
    coverUrlRef.current = undefined;
    setCoverUrl(undefined);
    void (async () => {
      try {
        const status = await getOfflineContentStatus(book.id, book.content_version);
        if (cancelled) return;
        setChapterCount(status.chapterCount);
        setPageCount(status.pageCount);
        setState(status.hasContent ? "partial" : "none");
        if (book.has_cover) {
          const cover = await getOfflineCover(book.id, book.content_version);
          if (!cancelled && cover) {
            const next = URL.createObjectURL(cover);
            coverUrlRef.current = next;
            setCoverUrl(next);
          }
        }
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
      if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current);
      coverUrlRef.current = undefined;
    };
  }, [book.id, book.content_version, book.has_cover, refreshToken]);

  return {
    state,
    chapterCount,
    pageCount,
    coverUrl,
    refresh: () => redraw((value) => value + 1),
    clearCache: async () => {
      await clearOfflineBookContent(book.id);
      redraw((value) => value + 1);
    },
  };
}
