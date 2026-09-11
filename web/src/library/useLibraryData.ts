import { useCallback, useEffect, useState } from "react";
import { api, type BrowseResponse, type HomeResponse } from "../api";

type LibrarySnapshot = { kind: "home"; value: HomeResponse } | { kind: "browse"; value: BrowseResponse };

/** Recent page summaries only; owned by the app and cleared when the session ends. */
export class LibraryPageCache {
  private readonly pages = new Map<string, LibrarySnapshot>();
  private revision = 0;

  get generation(): number { return this.revision; }

  get(key: string): LibrarySnapshot | null { return this.pages.get(key) ?? null; }

  set(key: string, value: LibrarySnapshot): void {
    this.pages.delete(key);
    this.pages.set(key, value);
    if (this.pages.size > 24) this.pages.delete(this.pages.keys().next().value!);
  }

  clear(): void { this.pages.clear(); this.revision += 1; }
}

export function useLibraryData(cache: LibraryPageCache, isBrowse: boolean, path: string) {
  const key = isBrowse ? `browse:${path}` : "home";
  const [state, setState] = useState(() => ({ key, data: cache.get(key), error: "" }));
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  // A new route can reuse its own snapshot immediately, never the previous directory.
  const data = state.key === key ? state.data : cache.get(key);
  const error = state.key === key ? state.error : "";

  useEffect(() => {
    const controller = new AbortController();
    const generation = cache.generation;
    const load = async () => {
      try {
        const snapshot: LibrarySnapshot = isBrowse
          ? { kind: "browse", value: await api.browse(path, controller.signal) }
          : { kind: "home", value: await api.home(controller.signal) };
        if (controller.signal.aborted || generation !== cache.generation) return;
        cache.set(key, snapshot);
        setState({ key, data: snapshot, error: "" });
      } catch (reason) {
        if (!controller.signal.aborted && generation === cache.generation) setState(current => ({
          key,
          data: current.key === key ? current.data ?? cache.get(key) : cache.get(key),
          error: reason instanceof Error ? reason.message : "书库加载失败",
        }));
      }
    };
    void load();
    return () => controller.abort();
  }, [cache, isBrowse, key, path, revision]);

  return {
    home: data?.kind === "home" ? data.value : null,
    browse: data?.kind === "browse" ? data.value : null,
    loading: !data && !error,
    error,
    refresh,
  };
}
