/** Remove active content and unsafe URLs from a book iframe document. */
export function sanitizeBookDocument(document: Document): void {
  document
    .querySelectorAll("script, iframe, object, embed, form, base, meta[http-equiv]")
    .forEach((element) => element.remove());
  document.querySelectorAll("style").forEach((element) => {
    element.textContent = sanitizeCssText(element.textContent ?? "");
  });
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith("on")) {
        element.removeAttribute(attribute.name);
      }
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const urlAttribute = ["href", "src", "xlink:href", "action", "formaction", "poster", "data", "srcset"].includes(name);
      const isNavigation = element.localName === "a" && name === "href";
      const blockedUrl = isNavigation ? isUnsafeUrl : isBlockedCssUrl;
      const unsafeUrl = name === "srcset"
        ? value.split(",").some((candidate) => blockedUrl(candidate.trim().split(/\s+/)[0] ?? ""))
        : blockedUrl(value);
      if (urlAttribute && unsafeUrl) {
        element.removeAttribute(attribute.name);
      }
      if (name === "style") {
        if (hasUnsafeCssUrl(attribute.value)) element.removeAttribute(attribute.name);
        else element.setAttribute(attribute.name, sanitizeCssText(attribute.value));
      }
    }
  });
  const head = document.head ?? document.documentElement;
  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = "default-src 'none'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline' blob: data:; font-src 'self' blob: data:; media-src 'self' blob: data:; object-src 'none'; frame-src 'none'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
  head.prepend(csp);
}

/**
 * Remove network and active URL references from book CSS while preserving
 * data/blob resources that the parent reader has already materialized.
 * Relative references are retained for the renderer's CSP to resolve; Foliate
 * normally rewrites them to blob URLs before this function runs.
 */
export function sanitizeCssText(value: string): string {
  const imports = /@import\s+(?:url\(\s*)?(["']?)([^\s"')]+)\1\s*\)?[^;]*;?/gi;
  let result = value.replace(imports, (whole, _quote: string, url: string) => {
    return isBlockedCssUrl(url) ? "" : whole;
  });
  const urls = /url\(\s*(["']?)(.*?)\1\s*\)/gis;
  result = result.replace(urls, (whole, _quote: string, url: string) => {
    return isBlockedCssUrl(url) ? "url(\"\")" : whole;
  });
  return result;
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

function isBlockedCssUrl(value: string): boolean {
  const normalized = value
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !/\s/.test(character) && code > 0x1f && code !== 0x7f && code !== 0xfffd;
    })
    .join("")
    .toLowerCase();
  return isUnsafeUrl(value)
    || normalized.startsWith("http:")
    || normalized.startsWith("https:")
    || normalized.startsWith("//");
}
