import { useCallback, useEffect, useRef, useState } from "react";
import type { BookSummary } from "../api";
import { api } from "../api";
import { deleteOfflineBook, downloadBook, getOfflineBook, getOfflineCover } from "./db";

export type OfflineBookState = "unknown" | "available" | "downloading" | "unavailable" | "error";

export function useOfflineBook(book: BookSummary) {
  const [state, setState] = useState<OfflineBookState>("unknown");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const coverUrlRef = useRef<string | null>(null);

  const replaceCover = useCallback((cover: Blob | null) => {
    if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current);
    const next = cover ? URL.createObjectURL(cover) : null;
    coverUrlRef.current = next;
    setCoverUrl(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    replaceCover(null);
    void Promise.all([
      getOfflineBook(book.id),
      book.has_cover ? getOfflineCover(book.id, book.content_version) : Promise.resolve(null),
    ]).then(([cached, cover]) => {
      if (cancelled) return;
      const available = cached?.content_version === book.content_version;
      setState(available ? "available" : "unavailable");
      if (available) replaceCover(cover);
    }).catch(() => {
      if (!cancelled) setState("unavailable");
    });
    return () => {
      cancelled = true;
      if (coverUrlRef.current) {
        URL.revokeObjectURL(coverUrlRef.current);
        coverUrlRef.current = null;
      }
    };
  }, [book.id, book.content_version, book.has_cover, replaceCover]);

  const toggle = useCallback(async () => {
    if (state === "downloading") {
      abortRef.current?.abort();
      return;
    }
    if (state === "available") {
      await deleteOfflineBook(book.id);
      replaceCover(null);
      setState("unavailable");
      return;
    }
    setState("downloading");
    setProgress(0);
    setErrorMessage(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let encoding = "";
      if (book.format === "txt") {
        try {
          encoding = localStorage.getItem(`moth:txt-encoding:${book.id}`) ?? "";
        } catch {
          // Use the server's automatic detection when localStorage is unavailable.
        }
      }
      const detail = await api.getBook(book.id, encoding);
      await downloadBook(book, detail, controller.signal, setProgress, encoding);
      const cover = book.has_cover ? await getOfflineCover(book.id, book.content_version) : null;
      replaceCover(cover);
      setProgress(100);
      setErrorMessage(null);
      setState("available");
    } catch (error) {
      if ((error as DOMException)?.name !== "AbortError") console.error("offline download failed", error);
      const cancelled = (error as DOMException)?.name === "AbortError";
      setErrorMessage(cancelled ? null : error instanceof Error ? error.message : "Download failed. Try again.");
      setState(cancelled ? "unavailable" : "error");
    } finally {
      abortRef.current = null;
    }
  }, [book, replaceCover, state]);

  return { state, progress, coverUrl, errorMessage, toggle };
}
