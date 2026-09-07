import type { BookDetail } from "../api";
import { api } from "../api";

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

  #blobs = new Map<string, string>();
  #encoding: string | undefined;

  constructor(
    private readonly detail: BookDetail,
    encoding?: string,
  ) {
    this.#encoding = encoding;
    this.metadata = { title: detail.title };
    this.sections = detail.chapters.map((chapter) => {
      const id = String(chapter.idx);
      return {
        id,
        size: Math.max(chapter.size, 1),
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
    this.#blobs.clear();
  }

  async #load(id: string): Promise<string> {
    const cached = this.#blobs.get(id);
    if (cached) return cached;
    const chapter = await api.getChapter(
      this.detail.id,
      Number(id),
      this.#encoding,
      this.detail.content_version,
    );
    const html = wrapChapter(chapter.title, chapter.content);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    this.#blobs.set(id, url);
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
  const csp = "default-src 'none'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline' blob:; font-src 'self' blob: data:; media-src 'self' blob: data:; object-src 'none'; frame-src 'none'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body>${heading}${content}</body></html>`;
}
