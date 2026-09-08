import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ProgressBody, type ReadingPosition } from "../api";

type PendingWrite = { publicationId: number; value: ProgressBody };
type QueuedWrite = { pending: PendingWrite; allowStale: boolean };

type Options = {
  publicationId: number;
  contentVersion: string;
};

type ProgressSaver = {
  save: (position: ReadingPosition, contentVersion?: string) => void;
  flush: () => Promise<void>;
  retry: () => Promise<void>;
  error: string;
};

const DEBOUNCE_MS = 450;
const SAVE_ERROR = "进度保存失败，请检查服务器连接后继续阅读";

/**
 * Persist the latest position for one publication without an offline queue.
 *
 * Writes are debounced and serialized so rapid page turns only send the last
 * position. The latest dirty value is flushed when the document is hidden or
 * the reader is unmounted. Each queued item carries its publication id, which
 * prevents a stale callback from ever writing to a newly opened book.
 */
export function useProgressSaver({ publicationId, contentVersion }: Options): ProgressSaver {
  const timer = useRef<number | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef<PendingWrite | null>(null);
  const queued = useRef<QueuedWrite | null>(null);
  const dirty = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState("");

  const enqueue = useCallback((pending: PendingWrite, allowStale = false): Promise<void> => {
    if (queued.current?.pending === pending) {
      // A route-change flush can upgrade a write that was already queued by
      // the debounce timer. It must not be discarded merely because the new
      // book produced a position before the old request reached the queue.
      queued.current.allowStale ||= allowStale;
      return queue.current;
    }
    const queuedWrite: QueuedWrite = { pending, allowStale };
    queued.current = queuedWrite;
    const task = queue.current
      .catch(() => undefined)
      .then(async () => {
        // A newer position supersedes a queued one before it starts. An
        // in-flight request cannot be cancelled, but it is never followed by
        // a stale success that clears the newer dirty value.
        if (!queuedWrite.allowStale && latest.current !== pending) return;
        try {
          await api.saveProgress(pending.publicationId, pending.value);
          if (latest.current === pending) dirty.current = false;
        } catch (reason) {
          if (latest.current === pending) {
            dirty.current = true;
            if (mounted.current) setError(SAVE_ERROR);
          }
          throw reason;
        } finally {
          if (queued.current?.pending === pending) queued.current = null;
        }
      });
    queue.current = task;
    return task;
  }, []);

  const flush = useCallback((allowStale = false): Promise<void> => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const pending = latest.current;
    if (!pending || !dirty.current) return queue.current;
    return enqueue(pending, allowStale);
  }, [enqueue]);

  const save = useCallback((position: ReadingPosition, version = contentVersion): void => {
    if (!Number.isFinite(publicationId) || publicationId <= 0 || !version) return;
    const pending: PendingWrite = {
      publicationId,
      value: { content_version: version, position },
    };
    latest.current = pending;
    dirty.current = true;
    setError("");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void enqueue(pending).catch(() => undefined);
    }, DEBOUNCE_MS);
  }, [contentVersion, enqueue, publicationId]);

  const retry = useCallback((): Promise<void> => {
    const pending = latest.current;
    if (!pending || !dirty.current) return queue.current;
    setError("");
    return enqueue(pending).catch(() => undefined);
  }, [enqueue]);

  useEffect(() => {
    mounted.current = true;
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") void flush(true).catch(() => undefined);
    };
    const onPageHide = () => { void flush(true).catch(() => undefined); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      // The dependency list includes the publication identity. React runs
      // this cleanup before a new book's effects, so a route change flushes
      // the old book while its pending value is still current.
      void flush(true).catch(() => undefined);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      mounted.current = false;
    };
  }, [contentVersion, flush, publicationId]);

  return { save, flush, retry, error };
}
