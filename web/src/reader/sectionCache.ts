type Section = {
  load: () => Promise<string | null>;
  unload: () => void;
  linear?: string;
};

/** Keep a small window of EPUB sections, including their rewritten image URLs.
 * Serialize extraction because Foliate's shared resource reference counts are
 * not safe for concurrent section loads. Foreground loads reuse pending work.
 */
export function cacheSections(sections: Section[], fixedLayout = false) {
  const originals = sections.map((section) => ({
    load: section.load.bind(section),
    unload: section.unload.bind(section),
  }));
  const entries = new Map<number, { promise: Promise<string | null>; loaded: boolean }>();
  let retained = new Set<number>();
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let current = -1;

  const release = (index: number) => {
    if (!entries.get(index)?.loaded) return;
    entries.delete(index);
    originals[index].unload();
  };
  const load = (index: number) => {
    const cached = entries.get(index);
    if (cached) return cached.promise;
    const entry = { promise: Promise.resolve<string | null>(null), loaded: false };
    entry.promise = queue.then(async () => {
      if (closed || !retained.has(index)) {
        entries.delete(index);
        return null;
      }
      try {
        const src = await originals[index].load();
        entry.loaded = true;
        if (closed || !retained.has(index)) release(index);
        return src;
      } catch (error) {
        entries.delete(index);
        // Failed transforms can still own some successfully loaded resources.
        originals[index].unload();
        throw error;
      }
    });
    entries.set(index, entry);
    queue = entry.promise.catch(() => undefined);
    return entry.promise;
  };

  sections.forEach((section, index) => {
    section.load = () => {
      retained.add(index);
      return load(index);
    };
    // Evict only after relocation, when the old document is no longer visible.
    section.unload = () => {};
  });

  return {
    relocate(index: number) {
      if (closed || index === current || !Number.isInteger(index) || !sections[index]) return;
      current = index;
      const radius = fixedLayout ? 2 : 1;
      retained = new Set(Array.from({ length: radius * 2 + 1 }, (_, i) => index - radius + i)
        .filter((i) => i >= 0 && i < sections.length));
      for (const previous of entries.keys()) if (!retained.has(previous)) release(previous);
      // Only prefetch forward; recently read sections stay available for back taps.
      for (let next = index + 1; next <= index + radius && next < sections.length; next++) {
        if (sections[next].linear !== "no") void load(next).catch(() => undefined);
      }
    },
    async destroy() {
      closed = true;
      retained.clear();
      await queue;
      for (const index of entries.keys()) release(index);
      sections.forEach((section, index) => Object.assign(section, originals[index]));
    },
  };
}
