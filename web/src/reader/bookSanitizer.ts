/** Remove active content and unsafe URLs from a book iframe document. */
export function sanitizeBookDocument(document: Document): void {
  document
    .querySelectorAll("script, iframe, object, embed, form, base, meta[http-equiv]")
    .forEach((element) => element.remove());
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on")) {
        element.removeAttribute(attribute.name);
      }
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const urlAttribute = ["href", "src", "xlink:href", "action", "formaction", "poster", "data", "srcset"].includes(name);
      const unsafeUrl = name === "srcset"
        ? value.split(",").some((candidate) => isUnsafeUrl(candidate.split(/\s+/)[0] ?? ""))
        : isUnsafeUrl(value);
      if (urlAttribute && unsafeUrl) {
        element.removeAttribute(attribute.name);
      }
      if (name === "style" && hasUnsafeCssUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  const head = document.head ?? document.documentElement;
  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = "default-src 'none'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline' blob:; font-src 'self' blob: data:; media-src 'self' blob: data:; object-src 'none'; frame-src 'none'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
  head.prepend(csp);
}

/**
 * URL schemes can be obfuscated with ASCII whitespace/control characters
 * (for example `java\nscript:`). Normalize those characters before checking
 * the scheme so the browser cannot reinterpret a value after sanitization.
 */
function isUnsafeUrl(value: string): boolean {
  const normalized = value
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !/\s/.test(character) && code > 0x1f && code !== 0x7f && code !== 0xfffd;
    })
    .join("")
    .toLowerCase();
  return normalized.startsWith("javascript:")
    || normalized.startsWith("vbscript:")
    || normalized.startsWith("data:text/html")
    || normalized.startsWith("data:application/xhtml+xml")
    || normalized.startsWith("file:")
    || normalized.startsWith("filesystem:");
}

function hasUnsafeCssUrl(value: string): boolean {
  const urlPattern = /url\s*\(\s*(['"]?)(.*?)\1\s*\)/gis;
  return Array.from(value.matchAll(urlPattern)).some((match) => isUnsafeUrl(match[2] ?? ""));
}
