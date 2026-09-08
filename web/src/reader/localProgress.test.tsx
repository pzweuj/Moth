import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, ApiError, type ProgressBody } from "../api";
import { drainOfflineWrites, getLocalProgress, listPendingProgress, setOfflineScope, unfreezeOfflineStorage } from "../offline/db";
import { useProgressSaver } from "./useProgressSaver";

const position = (percent: number): ProgressBody => ({ chapter_index: 0, page_index: percent, percent });
const response = (percent: number, revision = 1) => ({ progress: position(percent), revision, conflict: false });
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  localStorage.clear();
  setOfflineScope("reader", "server", "1");
  unfreezeOfflineStorage();
});
afterEach(async () => {
  cleanup();
  await drainOfflineWrites();
  await waitFor(() => expect(awaiting).toBe(0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
let awaiting = 0;
const flush = () => act(() => { window.dispatchEvent(new Event("pagehide")); });

it("persists new positions while a request hangs, then sends the latest after the old response", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  const sync = vi.spyOn(api, "syncProgress").mockImplementationOnce(() => {
    awaiting++;
    return new Promise((resolve) => { finish = (value) => { awaiting--; resolve(value); }; });
  }).mockResolvedValue(response(20, 2));
  const { result } = renderHook(() => useProgressSaver(1, "v1"));
  act(() => result.current.onProgress(position(10)));
  await waitFor(async () => expect((await getLocalProgress(1, "v1"))?.percent).toBe(10));
  flush();
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  act(() => result.current.onProgress(position(20)));
  await waitFor(async () => expect((await getLocalProgress(1, "v1"))?.percent).toBe(20));
  await act(async () => { finish(response(10)); });
  await waitFor(() => expect(result.current.saveState).toBe("saved"));
  expect(sync).toHaveBeenLastCalledWith(1, expect.objectContaining({ percent: 20, base_revision: 1 }));
  expect(await listPendingProgress()).toEqual([]);
});

it.each(["online", "visibilitychange"])("retries durable work on %s", async (event) => {
  const sync = vi.spyOn(api, "syncProgress").mockRejectedValueOnce(new ApiError(401, "invalid_credentials", "Login"))
    .mockResolvedValue(response(10));
  const { result } = renderHook(() => useProgressSaver(1, "v1"));
  act(() => result.current.onProgress(position(10)));
  await waitFor(async () => expect(await listPendingProgress()).toHaveLength(1));
  flush();
  await waitFor(() => expect(result.current.saveState).toBe("needs-login"));
  act(() => {
    if (event === "online") window.dispatchEvent(new Event(event));
    else document.dispatchEvent(new Event(event));
  });
  await waitFor(() => expect(result.current.saveState).toBe("saved"));
  expect(sync).toHaveBeenCalledTimes(2);
});

it("saves offline immediately and resumes on reconnect", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const sync = vi.spyOn(api, "syncProgress").mockResolvedValue(response(10));
  const { result } = renderHook(() => useProgressSaver(1, "v1"));
  act(() => result.current.onProgress(position(10)));
  await waitFor(() => expect(result.current.saveState).toBe("offline"));
  expect((await getLocalProgress(1, "v1"))?.percent).toBe(10);
  expect(sync).not.toHaveBeenCalled();
  online.mockReturnValue(true);
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(result.current.saveState).toBe("saved"));
});

it("does not report local save success or send progress after quota failure", async () => {
  const sync = vi.spyOn(api, "syncProgress").mockResolvedValue(response(10));
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "queue") throw new DOMException("Full", "QuotaExceededError");
    return original.apply(this, args);
  });
  const { result } = renderHook(() => useProgressSaver(1, "v1"));
  act(() => result.current.onProgress(position(10)));
  await waitFor(() => expect(result.current.saveState).toBe("local-error"));
  flush();
  expect(await listPendingProgress()).toEqual([]);
  expect(await getLocalProgress(1, "v1")).toBeNull();
  expect(sync).not.toHaveBeenCalled();
  expect(result.current.saveState).toBe("local-error");
});
