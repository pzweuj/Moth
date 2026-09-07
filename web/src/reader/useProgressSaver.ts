import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ProgressBody } from "../api";
import {
  enqueueProgress,
  listPendingProgress,
  removePendingProgress,
  saveLocalProgress,
} from "../offline/db";

export type SaveState = "idle" | "saving" | "saved" | "offline" | "needs-login" | "error";

const SAVE_DELAY_MS = 1500;

/**
 * Debounced progress persistence: the latest location is saved after a short
 * pause in movement and flushed when the reader unmounts. A failed save keeps
 * its payload pending so the next attempt (a later page turn or the unmount
 * flush) retries it.
 */
export function useProgressSaver(
  bookId: number,
  contentVersion?: string,
  initialRevision = 0,
  encoding?: string,
) {
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<ProgressBody | null>(null);
  const revisionRef = useRef(0);
  const sendingRef = useRef<Promise<void>>(Promise.resolve());
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    revisionRef.current = initialRevision;
  }, [initialRevision, contentVersion, encoding]);

  const normalizedEncoding = encoding?.trim().toLowerCase() || (encoding === undefined ? undefined : "auto");
  const withEncoding = useCallback(
    (value: ProgressBody): ProgressBody =>
      normalizedEncoding === undefined ? value : { ...value, encoding: normalizedEncoding },
    [normalizedEncoding],
  );

  const send = useCallback(
    (value: ProgressBody) => {
      const run = async () => {
        setSaveState("saving");
        let operationKey: string | null = null;
        try {
          if (!contentVersion) {
            await api.putProgress(bookId, value);
          } else {
            await saveLocalProgress(bookId, contentVersion, value);
            const operation = await enqueueProgress(bookId, contentVersion, value, revisionRef.current);
            operationKey = operation.key;
            if (typeof navigator !== "undefined" && !navigator.onLine) {
              if (pendingRef.current === value) pendingRef.current = null;
              setSaveState("offline");
              return;
            }
            const result = await api.syncProgress(bookId, {
              ...value,
              content_version: contentVersion,
              base_revision: revisionRef.current,
              operation_id: operation.operationId,
              encoding: normalizedEncoding,
            });
            revisionRef.current = result.revision;
            await saveLocalProgress(bookId, contentVersion, {
              ...result.progress,
              revision: result.revision,
              content_version: contentVersion,
              encoding: result.progress.encoding ?? normalizedEncoding,
            });
            await removePendingProgress(operation.key);
          }
          if (pendingRef.current === value) pendingRef.current = null;
          setSaveState("saved");
        } catch (error) {
          console.error("progress save failed", error);
          if (operationKey && error instanceof ApiError && error.code === "content_changed") {
            await removePendingProgress(operationKey).catch(() => undefined);
          }
          setSaveState(error instanceof ApiError && (error.status === 401 || error.status === 403)
            ? "needs-login"
            : "error");
        }
      };
      const next = contentVersion ? sendingRef.current.then(run, run) : run();
      sendingRef.current = next.then(() => undefined, () => undefined);
      return next;
    },
    [bookId, contentVersion, normalizedEncoding],
  );

  const syncPending = useCallback(() => {
    const run = async () => {
      if (!contentVersion || (typeof navigator !== "undefined" && !navigator.onLine)) return;
      let pending;
      try {
        pending = await listPendingProgress();
      } catch (error) {
        console.error("could not read offline progress queue", error);
        setSaveState("error");
        return;
      }
      for (const operation of pending.filter((item) => {
        if (item.bookId !== bookId || item.contentVersion !== contentVersion) return false;
        if (normalizedEncoding === undefined) return !item.value.encoding;
        return (item.value.encoding?.trim().toLowerCase() || "auto") === normalizedEncoding;
      })) {
        try {
          setSaveState("saving");
          const result = await api.syncProgress(bookId, {
            ...operation.value,
            content_version: contentVersion,
            base_revision: operation.baseRevision,
            operation_id: operation.operationId,
            encoding: normalizedEncoding,
          });
          revisionRef.current = result.revision;
          await saveLocalProgress(bookId, contentVersion, {
            ...result.progress,
            revision: result.revision,
            content_version: contentVersion,
            encoding: result.progress.encoding ?? normalizedEncoding,
          });
          await removePendingProgress(operation.key);
          setSaveState("saved");
        } catch (error) {
          console.error("offline progress sync failed", error);
          if (error instanceof ApiError && error.code === "content_changed") {
            await removePendingProgress(operation.key).catch(() => undefined);
          }
          setSaveState(error instanceof ApiError && (error.status === 401 || error.status === 403)
            ? "needs-login"
            : "error");
          return;
        }
      }
    };
    const next = sendingRef.current.then(run, run);
    sendingRef.current = next.then(() => undefined, () => undefined);
    return next;
  }, [bookId, contentVersion, normalizedEncoding]);

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
      pendingRef.current = withEncoding(progress);
      if (timerRef.current != null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const value = pendingRef.current;
        if (value) void send(value);
      }, SAVE_DELAY_MS);
    },
    [send, withEncoding],
  );

  // Flush on unmount (and on book change) so a reader closed mid-session
  // still persists its place.
  useEffect(() => {
    void syncPending();
    const onOnline = () => void syncPending();
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncPending();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      flush();
    };
  }, [flush, syncPending]);

  return { onProgress, saveState };
}
