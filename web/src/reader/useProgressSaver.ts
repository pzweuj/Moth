import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ProgressBody } from "../api";
import {
  acknowledgeProgress,
  listPendingProgress,
  removePendingProgress,
  saveProgressAndEnqueue,
  type PendingProgress,
} from "../offline/db";

export type SaveState = "idle" | "local-saved" | "saving" | "saved" | "offline" | "needs-login" | "error" | "local-error";

const SAVE_DELAY_MS = 1500;
const bookLocks = new Map<string, Promise<void>>();

function lockKey(bookId: number, version: string, encoding?: string): string {
  return `${bookId}:${version}:${encoding?.trim().toLowerCase() || "none"}`;
}

function withBookLock(key: string, task: () => Promise<void>): Promise<void> {
  const previous = bookLocks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  bookLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

function samePosition(a: ProgressBody, b: ProgressBody): boolean {
  return a.chapter_index === b.chapter_index
    && a.page_index === b.page_index
    && a.percent === b.percent
    && a.cfi === b.cfi
    && a.encoding === b.encoding;
}

/**
 * Local-first progress persistence. A position is written to IndexedDB as
 * soon as the reader reports it; the debounced network request is independent
 * and can never overwrite a newer local operation when responses arrive out
 * of order.
 */
export function useProgressSaver(bookId: number, contentVersion?: string, initialRevision = 0, encoding?: string) {
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<ProgressBody | null>(null);
  const revisionRef = useRef(initialRevision);
  const persistChainRef = useRef<Promise<PendingProgress | null>>(Promise.resolve(null));
  const sendingRef = useRef<Promise<void>>(Promise.resolve());
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    revisionRef.current = initialRevision;
  }, [initialRevision, contentVersion, encoding]);

  const normalizedEncoding = encoding?.trim().toLowerCase() || (encoding === undefined ? undefined : "auto");
  const withEncoding = useCallback(
    (value: ProgressBody): ProgressBody => normalizedEncoding === undefined ? value : { ...value, encoding: normalizedEncoding },
    [normalizedEncoding],
  );

  const syncOperation = useCallback(async (operation: PendingProgress): Promise<boolean> => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setSaveState("offline");
      return false;
    }
    setSaveState("saving");
    try {
      const result = await api.syncProgress(bookId, {
        ...operation.value,
        content_version: operation.contentVersion,
        base_revision: operation.baseRevision,
        operation_id: operation.operationId,
        encoding: normalizedEncoding,
      });
      revisionRef.current = result.revision;
      const applied = await acknowledgeProgress(operation, {
        ...result.progress,
        encoding: result.progress.encoding ?? operation.value.encoding,
      }, result.revision);
      if (applied) setSaveState("saved");
      else if (typeof navigator !== "undefined" && !navigator.onLine) setSaveState("offline");
      else setSaveState("local-saved");
      return applied;
    } catch (error) {
      if (error instanceof ApiError && error.code === "content_changed") {
        // The old version can never be uploaded. Leaving a newer operation in
        // the queue is safe; the server response only acknowledges its own id.
        await removePendingProgress(operation.key).catch(() => undefined);
        setSaveState("error");
      } else {
        setSaveState(error instanceof ApiError && (error.status === 401 || error.status === 403) ? "needs-login" : "error");
      }
      throw error;
    }
  }, [bookId, normalizedEncoding]);

  const syncLatest = useCallback(async (value: ProgressBody): Promise<void> => {
    if (!contentVersion) {
      try {
        setSaveState("saving");
        await api.putProgress(bookId, value);
        if (samePosition(value, pendingRef.current ?? value)) {
          pendingRef.current = null;
          setSaveState("saved");
        }
      } catch (error) {
        setSaveState(error instanceof ApiError && (error.status === 401 || error.status === 403) ? "needs-login" : "error");
      }
      return;
    }

    await persistChainRef.current.catch(() => null);
    const key = lockKey(bookId, contentVersion, normalizedEncoding);
    try {
      await withBookLock(key, async () => {
        // A stale response can replace the operation while its request is in
        // flight. Re-read once after that response so the latest position is
        // sent immediately instead of waiting for another lifecycle event.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const current = (await listPendingProgress())
            .filter((item) => item.bookId === bookId && item.contentVersion === contentVersion)
            .filter((item) => normalizedEncoding === undefined
              ? !item.value.encoding
              : (item.value.encoding?.trim().toLowerCase() || "auto") === normalizedEncoding)
            .sort((a, b) => b.localSequence - a.localSequence)[0];
          if (!current) return;
          const applied = await syncOperation(current);
          if (applied) return;
        }
      });
    } catch {
      // The state indicator is set by syncOperation; keep the operation queued
      // for the global reconnect/login retry.
    }
  }, [bookId, contentVersion, normalizedEncoding, syncOperation]);

  const send = useCallback((value: ProgressBody) => {
    if (!contentVersion) return syncLatest(value);
    const next = sendingRef.current.then(() => syncLatest(value), () => syncLatest(value));
    sendingRef.current = next.then(() => undefined, () => undefined);
    return next;
  }, [contentVersion, syncLatest]);

  const schedule = useCallback(() => {
    if (timerRef.current != null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const value = pendingRef.current;
      if (value) void send(value);
    }, SAVE_DELAY_MS);
  }, [send]);

  const onProgress = useCallback((progress: ProgressBody) => {
    const value = withEncoding(progress);
    pendingRef.current = value;
    if (contentVersion) {
      // The write and queue insertion happen in one transaction immediately;
      // this promise is deliberately independent of the network debounce.
      const persist = persistChainRef.current.then(async () => {
        try {
          const operation = await saveProgressAndEnqueue(bookId, contentVersion, value, revisionRef.current);
          if (typeof navigator !== "undefined" && !navigator.onLine) setSaveState("offline");
          else setSaveState("local-saved");
          return operation;
        } catch (error) {
          setSaveState("local-error");
          throw error;
        }
      });
      persistChainRef.current = persist.then((operation) => operation, () => null);
    }
    schedule();
  }, [bookId, contentVersion, schedule, withEncoding]);

  const flush = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending) void send(pending);
  }, [send]);

  const syncPending = useCallback(() => {
    if (!contentVersion || (typeof navigator !== "undefined" && !navigator.onLine)) return Promise.resolve();
    return withBookLock(lockKey(bookId, contentVersion, normalizedEncoding), async () => {
      for (;;) {
        const pending = await listPendingProgress();
        const operation = pending
          .filter((item) => item.bookId === bookId && item.contentVersion === contentVersion)
          .filter((item) => normalizedEncoding === undefined
            ? !item.value.encoding
            : (item.value.encoding?.trim().toLowerCase() || "auto") === normalizedEncoding)
          .sort((a, b) => a.createdAt - b.createdAt || a.localSequence - b.localSequence)[0];
        if (!operation) return;
        try {
          const applied = await syncOperation(operation);
          if (!applied) continue;
        } catch {
          break;
        }
      }
    });
  }, [bookId, contentVersion, normalizedEncoding, syncOperation]);

  useEffect(() => {
    void syncPending();
    const onOnline = () => void syncPending();
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncPending();
      else flush();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush, syncPending]);

  return { onProgress, saveState };
}
