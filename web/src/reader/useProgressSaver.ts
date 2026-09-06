import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ProgressBody } from "../api";

export type SaveState = "idle" | "saving" | "saved" | "error";

const SAVE_DELAY_MS = 1500;

/**
 * Debounced progress persistence: the latest location is saved after a short
 * pause in movement and flushed when the reader unmounts. A failed save keeps
 * its payload pending so the next attempt (a later page turn or the unmount
 * flush) retries it.
 */
export function useProgressSaver(bookId: number) {
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<ProgressBody | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const send = useCallback(
    async (value: ProgressBody) => {
      setSaveState("saving");
      try {
        await api.putProgress(bookId, value);
        pendingRef.current = null;
        setSaveState("saved");
      } catch (error) {
        console.error("progress save failed", error);
        setSaveState("error");
      }
    },
    [bookId],
  );

  const flush = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending) void send(pending);
  }, [send]);

  const onProgress = useCallback(
    (progress: ProgressBody) => {
      pendingRef.current = progress;
      if (timerRef.current != null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const value = pendingRef.current;
        if (value) void send(value);
      }, SAVE_DELAY_MS);
    },
    [send],
  );

  // Flush on unmount (and on book change) so a reader closed mid-session
  // still persists its place.
  useEffect(() => flush, [flush]);

  return { onProgress, saveState };
}
