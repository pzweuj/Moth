import { describe, expect, it, vi } from "vitest";
import { cacheSections } from "./sectionCache";

function fixture(count = 8, fixed = false) {
  const originals = Array.from({ length: count }, (_, index) => ({
    load: vi.fn(async () => `blob:section-${index}`), unload: vi.fn(),
  }));
  const sections = originals.map((section) => ({ ...section }));
  const cache = cacheSections(sections, fixed);
  return { originals, sections, cache };
}

describe("EPUB section cache", () => {
  it("prepares the next section and reuses images when turning back", async () => {
    const { originals, sections, cache } = fixture();
    await sections[0].load();
    cache.relocate(0);
    await vi.waitFor(() => expect(originals[1].load).toHaveBeenCalledTimes(1));
    expect(await sections[1].load()).toBe("blob:section-1");
    sections[0].unload();
    cache.relocate(1);
    expect(await sections[0].load()).toBe("blob:section-0");
    expect(originals[0].load).toHaveBeenCalledTimes(1);
    expect(originals[0].unload).not.toHaveBeenCalled();
    await sections[2].load();
    cache.relocate(2);
    expect(originals[0].unload).toHaveBeenCalledTimes(1);
    expect(originals[1].load).toHaveBeenCalledTimes(1);
    await cache.destroy();
  });

  it("deduplicates an in-flight prefetch and serializes shared resource loading", async () => {
    const { originals, sections, cache } = fixture();
    let complete!: (src: string) => void;
    originals[1].load.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    await sections[0].load();
    cache.relocate(0);
    await vi.waitFor(() => expect(complete).toBeDefined());
    const next = sections[1].load();
    const jump = sections[5].load();
    expect(originals[5].load).not.toHaveBeenCalled();
    complete("blob:prefetched");
    expect(await next).toBe("blob:prefetched");
    expect(await jump).toBe("blob:section-5");
    expect(originals[1].load).toHaveBeenCalledTimes(1);
    cache.relocate(5);
    expect(originals[0].unload).toHaveBeenCalledTimes(1);
    expect(originals[1].unload).toHaveBeenCalledTimes(1);
    await cache.destroy();
  });

  it("allows a failed speculative load to be retried by a tap", async () => {
    const { originals, sections, cache } = fixture();
    originals[1].load.mockRejectedValueOnce(new Error("temporary network failure"));
    await sections[0].load();
    cache.relocate(0);
    await vi.waitFor(() => expect(originals[1].unload).toHaveBeenCalledTimes(1));
    expect(await sections[1].load()).toBe("blob:section-1");
    expect(originals[1].load).toHaveBeenCalledTimes(2);
    await cache.destroy();
  });

  it("retries a speculative rejection as an unrestricted foreground load", async () => {
    const { originals, sections, cache } = fixture();
    originals[1].load.mockImplementation(async (options?: { speculative?: boolean }) => {
      if (options?.speculative) throw new Error("resource budget exceeded");
      return "blob:foreground";
    });
    await sections[0].load();
    cache.relocate(0);
    await vi.waitFor(() => expect(originals[1].load).toHaveBeenCalledTimes(1));
    expect(await sections[1].load()).toBe("blob:foreground");
    expect(originals[1].load).toHaveBeenCalledTimes(2);
    await cache.destroy();
  });

  it("evicts the farthest inactive section before a budgeted prefetch", async () => {
    let bytes = 0;
    const originals = Array.from({ length: 4 }, (_, index) => ({
      load: vi.fn(async () => { bytes += 10; return `blob:section-${index}`; }),
      unload: vi.fn(() => { bytes -= 10; }),
    }));
    const sections = originals.map((section) => ({ ...section, size: 10 }));
    const cache = cacheSections(sections, false, { getResourceBytes: () => bytes, resourceBudget: 20 });
    await sections[0].load();
    await sections[1].load();
    cache.relocate(1);
    await vi.waitFor(() => expect(originals[2].load).toHaveBeenCalledTimes(1));
    expect(originals[0].unload).toHaveBeenCalledTimes(1);
    expect(bytes).toBe(20);
    await cache.destroy();
  });

  it("retains both fixed-layout pages and prepares the next spread without loading the book", async () => {
    const { originals, sections, cache } = fixture(20, true);
    await sections[2].load(); await sections[3].load();
    cache.relocate(3);
    await vi.waitFor(() => expect(originals[5].load).toHaveBeenCalledTimes(1));
    expect(originals[2].unload).not.toHaveBeenCalled();
    expect(originals.slice(6).every((section) => section.load.mock.calls.length === 0)).toBe(true);
    await cache.destroy();
    for (const section of originals.slice(2, 6)) expect(section.unload).toHaveBeenCalledTimes(1);
  });

  it("releases a prefetch finishing after close and cancels queued extraction", async () => {
    const { originals, sections, cache } = fixture(8, true);
    let complete!: (src: string) => void;
    originals[1].load.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    await sections[0].load(); cache.relocate(0);
    await vi.waitFor(() => expect(complete).toBeDefined());
    const closed = cache.destroy();
    complete("blob:late"); await closed;
    expect(originals[0].unload).toHaveBeenCalledTimes(1);
    expect(originals[1].unload).toHaveBeenCalledTimes(1);
    expect(originals[2].load).not.toHaveBeenCalled();
  });
});
