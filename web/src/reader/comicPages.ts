const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];

/** True when a CBZ entry name looks like an image page. */
export function isComicImage(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/** Natural ordering so `page_2` sorts before `page_10`. */
export function comparePageNames(a: string, b: string): number {
  return new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  }).compare(a, b);
}

/** Keep only image entries, ordered naturally by filename. */
export function sortComicEntries<T extends { filename: string }>(
  entries: T[],
): T[] {
  return entries
    .filter((entry) => isComicImage(entry.filename))
    .sort((a, b) => comparePageNames(a.filename, b.filename));
}
