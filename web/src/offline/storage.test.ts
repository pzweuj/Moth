import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeProgress, clearOfflineContent, clearOfflineData, drainOfflineWrites,
  freezeOfflineStorage, getLocalProgress, getOfflineChapter, listPendingProgress,
  saveOfflineChapter, saveProgressAndEnqueue, setOfflineScope, unfreezeOfflineStorage,
} from "./db";

const position = (percent: number, encoding?: string) => ({ chapter_index: 0, page_index: percent, percent, encoding });

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  localStorage.clear();
  setOfflineScope("reader", "server-a", "1");
  unfreezeOfflineStorage();
});
afterEach(async () => {
  await drainOfflineWrites();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("durable offline storage", () => {
  it("atomically replaces only the latest operation in a content/decoder context", async () => {
    await saveProgressAndEnqueue(1, "v1", position(10, "gbk"), 0);
    await saveProgressAndEnqueue(1, "v1", position(20, "utf-8"), 0);
    await saveProgressAndEnqueue(1, "v2", position(30, "gbk"), 0);
    const latest = await saveProgressAndEnqueue(1, "v1", position(40, "gbk"), 1);
    expect(await listPendingProgress()).toHaveLength(3);
    expect(await getLocalProgress(1, "v1", "gbk")).toEqual(latest.value);
    expect((await getLocalProgress(1, "v1", "utf-8"))?.percent).toBe(20);
    expect((await getLocalProgress(1, "v2", "gbk"))?.percent).toBe(30);
    expect(await getLocalProgress(1, "v3", "gbk")).toBeNull();
  });

  it("rolls back the position when queue insertion throws and announces quota failure", async () => {
    await saveProgressAndEnqueue(1, "v1", position(10), 0);
    const listener = vi.fn();
    window.addEventListener("moth-offline-storage", listener);
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "queue") throw new DOMException("Full", "QuotaExceededError");
      return original.apply(this, args);
    });
    await expect(saveProgressAndEnqueue(1, "v1", position(20), 0)).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect((await getLocalProgress(1, "v1"))?.percent).toBe(10);
    expect((await listPendingProgress())[0]?.value.percent).toBe(10);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detail: { type: "quota" } }));
    window.removeEventListener("moth-offline-storage", listener);
  });

  it("rejects stale responses without losing the newer position or revision", async () => {
    const old = await saveProgressAndEnqueue(1, "v1", position(10), 0);
    const current = await saveProgressAndEnqueue(1, "v1", position(20), 0);
    expect(await acknowledgeProgress(old, position(10), 2)).toBe(false);
    expect((await getLocalProgress(1, "v1"))?.percent).toBe(20);
    expect(await listPendingProgress()).toEqual([{ ...current, baseRevision: 2 }]);
    expect(await acknowledgeProgress(current, position(30), 3)).toBe(true);
    expect((await getLocalProgress(1, "v1"))?.percent).toBe(30);
    expect(await listPendingProgress()).toEqual([]);
  });

  it("isolates chapters by version, encoding, parser, server and account", async () => {
    const chapter = { title: "One", content: "<p>one</p>" };
    await saveOfflineChapter(1, "v1", 0, "gbk", chapter);
    expect(await getOfflineChapter(1, "v1", 0, " GBK ")).toEqual(chapter);
    expect(await getOfflineChapter(1, "v2", 0, "gbk")).toBeNull();
    expect(await getOfflineChapter(1, "v1", 0, "utf-8")).toBeNull();
    expect(await getOfflineChapter(1, "v1", 0, "gbk", "txt-v2")).toBeNull();
    setOfflineScope("reader", "server-b", "1");
    expect(await getOfflineChapter(1, "v1", 0, "gbk")).toBeNull();
    setOfflineScope("reader", "server-a", "2");
    expect(await getOfflineChapter(1, "v1", 0, "gbk")).toBeNull();
    setOfflineScope("reader", "server-a", "1");
    expect(await getOfflineChapter(1, "v1", 0, "gbk")).toEqual(chapter);
  });

  it("clears content without losing progress or pending operations", async () => {
    await saveOfflineChapter(1, "v1", 0, "", { title: "One", content: "one" });
    const pending = await saveProgressAndEnqueue(1, "v1", position(10), 0);
    await clearOfflineContent();
    expect(await getOfflineChapter(1, "v1", 0)).toBeNull();
    expect(await getLocalProgress(1, "v1")).toEqual(pending.value);
    expect(await listPendingProgress()).toEqual([pending]);
  });

  it("drains in-flight writes before logout clears data, and blocks late writes", async () => {
    const write = saveProgressAndEnqueue(1, "v1", position(10), 0);
    freezeOfflineStorage();
    await drainOfflineWrites();
    await write;
    await clearOfflineData();
    await saveOfflineChapter(1, "v1", 0, "", { title: "Late", content: "late" });
    expect(await getLocalProgress(1, "v1")).toBeNull();
    expect(await listPendingProgress()).toEqual([]);
    expect(await getOfflineChapter(1, "v1", 0)).toBeNull();
  });
});
