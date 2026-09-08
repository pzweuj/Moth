import type { BookDetail } from "../api";
import { api } from "../api";
import { sanitizeBookDocument, sanitizeCssText } from "./bookSanitizer";
import { getOfflineResource, type CachedResource } from "../offline/db";

interface TextSection {
  id: string;
  size: number;
  linear: string;
  load: () => Promise<string>;
  unload: (url: string) => void;
}

/**
 * Implements the foliate-js book interface over Moth's chapter API, so plain
 * text books paginate through the same renderer as EPUB and MOBI. Each section
 * `load()` fetches the server-rendered chapter HTML and exposes it as a blob
 * URL for the paginator.
 *
 * `encoding` is an optional override for the server-side TXT decoder; changing
 * it re-decodes chapters from the original file without a rescan.
 */
export class TextPublication {
  readonly sections: TextSection[];
  readonly toc: { label: string; href: string }[];
  readonly metadata: { title: string };
  readonly dir = "ltr";
  /** Called when a requested unit is unavailable while offline. */
  onError?: (error: unknown) => void;

  #blobs = new Map<string, string>();
  #resourceBlobs = new Map<string, string>();
  #encoding: string | undefined;
  #parserVersion: string | undefined;

  constructor(
    private readonly detail: BookDetail,
    encoding?: string,
    parserVersion?: string,
    cachedSectionIndices?: number[],
  ) {
    this.#encoding = encoding;
    this.#parserVersion = parserVersion;
    this.metadata = { title: detail.title };
    // Foliate's MOBI/KF8 section numbers are byte-layout units and do not
    // necessarily match the server's heuristic chapter list. Preserve the
    // highest cached index when reopening offline so a saved CFI can still
    // resolve to the cached section (with uncached gaps reporting the normal
    // "connect to continue" error).
    const chapterByIndex = new Map(detail.chapters.map((chapter) => [chapter.idx, chapter]));
    const sectionCount = cachedSectionIndices?.length
      ? Math.max(detail.chapters.length, Math.max(...cachedSectionIndices) + 1)
      : detail.chapters.length;
    this.sections = Array.from({ length: sectionCount }, (_, index) => {
      const chapter = chapterByIndex.get(index);
      const id = String(index);
      return {
        id,
        size: Math.max(chapter?.size ?? 1, 1),
        linear: "yes",
        load: () => this.#load(id),
        unload: (url) => this.#unload(url),
      };
    });
    this.toc = detail.chapters.map((chapter) => ({
      label: chapter.title || `Chapter ${chapter.idx + 1}`,
      href: `#${chapter.idx}`,
    }));
  }

  resolveHref(href: string): { index: number; anchor: () => null } {
    const idx = Number(String(href).replace(/^#/, ""));
    return {
      index: this.sections.findIndex((section) => section.id === String(idx)),
      anchor: () => null,
    };
  }

  splitTOCHref(href: string): [string, null] | null {
    const match = /^#(\d+)$/.exec(String(href));
    return match ? [match[1], null] : null;
  }

  getTOCFragment(): null {
    return null;
  }

  isExternal(): boolean {
    return false;
  }

  async getCover(): Promise<Blob | null> {
    return null;
  }

  destroy(): void {
    for (const url of this.#blobs.values()) URL.revokeObjectURL(url);
    for (const url of this.#resourceBlobs.values()) URL.revokeObjectURL(url);
    this.#blobs.clear();
    this.#resourceBlobs.clear();
  }

  async #load(id: string): Promise<string> {
    const cached = this.#blobs.get(id);
    if (cached) return cached;
    let chapter;
    try {
      chapter = this.#parserVersion
        ? await api.getChapter(
          this.detail.id,
          Number(id),
          this.#encoding,
          this.detail.content_version,
          this.#parserVersion,
        )
        : await api.getChapter(
          this.detail.id,
          Number(id),
          this.#encoding,
          this.detail.content_version,
        );
    } catch (error) {
      this.onError?.(error);
      throw error;
    }
    const content = await this.#inlineCachedResources(chapter.content);
    const html = wrapChapter(chapter.title, content);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    this.#blobs.set(id, url);
    return url;
  }

  async #inlineCachedResources(content: string): Promise<string> {
    // Server generated EPUB links use /resource/<index>. Replacing only those
    // URLs keeps ordinary in-book anchors intact and lets offline chapters
    // render from the cached resource blobs without persisting object URLs.
    const pattern = /(\b(?:src|href)\s*=\s*["'])(\/api\/v1\/books\/\d+\/resource\/\d+)(["'])/gi;
    const matches = Array.from(content.matchAll(pattern));
    let result = content;
    for (const match of matches) {
      const original = match[2];
      if (!original) continue;
      let replacement: string | null | undefined = this.#resourceBlobs.get(original);
      if (!replacement) {
        const index = Number(original.substring(original.lastIndexOf("/") + 1));
        if (!Number.isInteger(index)) {
          result = result.replace(match[0], "");
          continue;
        }
        const resource = await getOfflineResource(this.detail.id, this.detail.content_version, String(index)).catch(() => null);
        // Resource URLs are removed when their body was not cached. Leaving
        // an authenticated API URL in the iframe would let a book initiate
        // network requests after the parent has already applied its CSP.
        if (!resource) {
          result = result.replace(match[0], "");
          continue;
        }
        replacement = await this.#resourceUrl(resource);
        if (!replacement) {
          result = result.replace(match[0], "");
          continue;
        }
        this.#resourceBlobs.set(original, replacement);
      }
      result = result.replace(match[0], `${match[1]}${replacement}${match[3]}`);
    }
    return result;
  }

  /** Rebuild a resource URL for this session; persisted data never contains a
   * temporary Blob URL. CSS dependencies are rewritten to other cached
   * resources so a blob stylesheet cannot fall back to an authenticated HTTP
   * request when the device is offline. */
  async #resourceUrl(resource: CachedResource, seen = new Set<string>()): Promise<string | null> {
    const cacheKey = resource.sourcePath ?? resource.path;
    const cached = this.#resourceBlobs.get(`path:${cacheKey}`);
    if (cached) return cached;
    if (seen.has(resource.key)) return null;
    seen.add(resource.key);
    let data = resource.data;
    if (isCssResource(resource)) {
      try {
        const css = await resource.data.text();
        const rewritten = await rewriteCssResources(
          css,
          resource.sourcePath ?? resource.path,
          async (path) => {
            const dependency = await getOfflineResource(this.detail.id, this.detail.content_version, path).catch(() => null);
            return dependency ? this.#resourceUrl(dependency, seen) : null;
          },
        );
        data = new Blob([rewritten], { type: resource.mime || "text/css" });
      } catch {
        // A malformed stylesheet should not prevent the chapter body from
        // opening. The CSP still blocks any network fallback from its blob.
      }
    }
    const url = URL.createObjectURL(data);
    this.#resourceBlobs.set(`path:${cacheKey}`, url);
    seen.delete(resource.key);
    return url;
  }

  #unload(url: string): void {
    URL.revokeObjectURL(url);
    for (const [id, cached] of this.#blobs) {
      if (cached === url) this.#blobs.delete(id);
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wrapChapter(title: string, content: string): string {
  const heading = title ? `<h1>${escapeHtml(title)}</h1>` : "";
  const csp = "default-src 'none'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline' blob: data:; font-src 'self' blob: data:; media-src 'self' blob: data:; object-src 'none'; frame-src 'none'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
  // Sanitize before serializing the iframe document. CSP is defense in depth;
  // removing active elements first also protects browsers that delay applying
  // a meta policy to a blob URL.
  const parsed = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${heading}${content}</body></html>`,
    "text/html",
  );
  sanitizeBookDocument(parsed);
  const body = parsed.body?.innerHTML ?? "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body>${body}</body></html>`;
}

/** Cache schema for sections materialized by Foliate's EPUB/MOBI loader. */
export const FOLIATE_PARSER_VERSION = "foliate-v1";

function isCssResource(resource: CachedResource): boolean {
  return resource.mime.toLowerCase().split(";")[0] === "text/css"
    || /\.css$/i.test(resource.sourcePath ?? resource.path);
}

function isExternalResourceReference(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !normalized
    || normalized.startsWith("#")
    || normalized.startsWith("data:")
    || normalized.startsWith("http:")
    || normalized.startsWith("https:")
    || normalized.startsWith("blob:")
    || normalized.startsWith("//");
}

function resolveArchivePath(base: string, reference: string): string {
  let value = reference.trim().replace(/^['"]|['"]$/g, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the original path when a malformed escape is present.
  }
  value = value.split(/[?#]/, 1)[0] ?? "";
  const parts = base.split("/");
  parts.pop();
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.filter(Boolean).join("/");
}

async function rewriteCssResources(
  css: string,
  base: string,
  resolve: (path: string) => Promise<string | null>,
): Promise<string> {
  const pattern = /url\(\s*(["']?)(.*?)\1\s*\)/gis;
  const matches = Array.from(css.matchAll(pattern));
  if (!matches.length) return css;
  let result = "";
  let offset = 0;
  for (const match of matches) {
    const start = match.index ?? offset;
    result += css.slice(offset, start);
    const reference = match[2] ?? "";
    if (isExternalResourceReference(reference)) {
      result += match[0];
    } else {
      const resolved = await resolve(resolveArchivePath(base, reference));
      result += resolved ? `url("${resolved}")` : "url(\"\")";
    }
    offset = start + match[0].length;
  }
  return sanitizeCssText(result + css.slice(offset));
}
