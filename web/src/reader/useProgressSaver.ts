import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ProgressWrite, type ReadingPosition } from "../api";

type PendingWrite = {
  publicationId: number;
  value: ProgressWrite;
  request?: Promise<void>;
  confirmed?: boolean;
};

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

function newWriterId(): string {
  // getRandomValues also works when a local installation is served over HTTP.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function useProgressSaver({ publicationId, contentVersion }: Options): ProgressSaver {
  const timer = useRef<number | null>(null);
  const queue = useRef(Promise.resolve());
  const writer = useRef<{ publicationId: number; id: string; sequence: number } | null>(null);
  const latest = useRef<PendingWrite | null>(null);
  const mounted = useRef(false);
  const [error, setError] = useState("");

  const send = useCallback((pending: PendingWrite): Promise<void> => {
    if (pending.confirmed) return Promise.resolve();
    if (pending.request) return pending.request;
    // Any request still in flight when the browser exits must be able to
    // finish. The server orders requests by writer and sequence.
    pending.request = api.saveProgress(pending.publicationId, pending.value, { keepalive: true })
      .then(() => {
        pending.confirmed = true;
        if (mounted.current && latest.current === pending) setError("");
      })
      .catch(reason => {
        if (mounted.current && latest.current === pending) setError(SAVE_ERROR);
        throw reason;
      })
      .finally(() => { pending.request = undefined; });
    return pending.request;
  }, []);

  const flush = useCallback((): Promise<void> => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    return latest.current ? send(latest.current) : Promise.resolve();
  }, [send]);

  const save = useCallback((position: ReadingPosition, version = contentVersion): void => {
    if (!Number.isFinite(publicationId) || publicationId <= 0 || !version) return;
    if (writer.current?.publicationId !== publicationId) {
      writer.current = { publicationId, id: newWriterId(), sequence: 0 };
    }
    const pending: PendingWrite = {
      publicationId,
      value: {
        content_version: version,
        position,
        writer_id: writer.current.id,
        sequence: ++writer.current.sequence,
      },
    };
    latest.current = pending;
    setError("");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      queue.current = queue.current.then(() => {
        if (latest.current === pending) return send(pending);
      }).catch(() => undefined);
    }, DEBOUNCE_MS);
  }, [contentVersion, publicationId, send]);

  const retry = useCallback((): Promise<void> => {
    setError("");
    return flush().catch(() => undefined);
  }, [flush]);

  useEffect(() => {
    mounted.current = true;
    const onPageHide = () => { void flush().catch(() => undefined); };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") onPageHide();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      mounted.current = false;
      onPageHide();
      latest.current = null;
    };
  }, [flush, publicationId]);

  return { save, flush, retry, error };
}
