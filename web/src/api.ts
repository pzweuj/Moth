export type Format = "epub" | "txt" | "cbz" | "mobi";

export type SessionState = { authenticated: boolean; username?: string };
export type SetupStatus = { initialized: boolean };

export type ReadingPosition =
  | { type: "epub"; href: string; cfi: string; progress: number }
  | { type: "txt"; chapter_index: number; character_offset: number; encoding: string; progress: number }
  | { type: "cbz"; page_index: number; page_progress: number; progress: number };

export type ProgressBody = { content_version: string; position: ReadingPosition };

export type PublicationSummary = {
  id: number;
  title: string;
  author: string | null;
  source_format: Format;
  reader_format: "epub" | "txt" | "cbz";
  cover_url?: string;
  progress: number;
  content_version: string;
  file_size: number;
  filename: string;
  library_key: string;
  library_name: string;
  directory_path: string;
  parse_status: string;
};

export type BookDetail = PublicationSummary & {
  chapters: Array<{ idx: number; title: string }>;
  pages: Array<{ idx: number; path: string; mime: string }>;
};

export type LibrarySummary = { key: string; name: string; publication_count: number; directory_count: number };
export type BrowseResponse = {
  library: LibrarySummary;
  path: string;
  breadcrumbs: Array<{ name: string; path: string }>;
  directories: Array<{ name: string; path: string; publication_count: number }>;
  publications: PublicationSummary[];
};
export type HomeResponse = { continue_reading: PublicationSummary[]; recently_added: PublicationSummary[]; novels: PublicationSummary[]; comics: PublicationSummary[] };
export type ChapterContent = { idx: number; title: string; content: string; encoding: string; content_version: string };
export type ConversionResponse = { status: "pending" | "preparing" | "ready" | "failed" | "not_required"; file_url?: string; error?: string };

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "ApiError"; this.status = status; this.code = code; }
}

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try { return await fetch(input, { ...init, signal: init.signal ?? controller.signal, credentials: "same-origin" }); }
  finally { window.clearTimeout(timeout); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: "same-origin" });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let value: unknown = null;
  try { value = text ? JSON.parse(text) : null; } catch { value = null; }
  if (!response.ok) {
    const error = value && typeof value === "object" ? (value as { error?: { code?: string; message?: string } }).error : undefined;
    throw new ApiError(response.status, error?.code ?? "request_failed", error?.message ?? `请求失败（${response.status}）`);
  }
  return value as T;
}

export const api = {
  setupStatus: () => request<SetupStatus>("/setup/status"),
  setup: (username: string, password: string) => request<void>("/setup", { method: "POST", body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) => request<void>("/session", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<void>("/session", { method: "DELETE" }),
  session: () => request<SessionState>("/session"),
  home: () => request<HomeResponse>("/home"),
  libraries: () => request<LibrarySummary[]>("/libraries"),
  browse: (key: string, path = "") => request<BrowseResponse>(`/libraries/${encodeURIComponent(key)}/browse?path=${encodeURIComponent(path)}`),
  publications: (query: { q?: string; library?: string; format?: Format | "all"; author?: string; sort?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value && value !== "all") params.set(key, value);
    return request<PublicationSummary[]>(`/publications${params.toString() ? `?${params}` : ""}`);
  },
  book: (id: number) => request<BookDetail>(`/publications/${id}`),
  progress: (id: number) => request<ProgressBody | null>(`/publications/${id}/progress`),
  saveProgress: (id: number, value: ProgressBody) => request<ProgressBody>(`/publications/${id}/progress`, { method: "PUT", body: JSON.stringify(value) }),
  chapter: (id: number, index: number, encoding?: string) => request<ChapterContent>(`/publications/${id}/chapters/${index}${encoding ? `?encoding=${encodeURIComponent(encoding)}` : ""}`),
  conversion: (id: number) => request<ConversionResponse>(`/publications/${id}/conversion`),
  startConversion: (id: number) => request<ConversionResponse>(`/publications/${id}/conversion`, { method: "POST" }),
  scan: (key: string) => request<void>(`/libraries/${encodeURIComponent(key)}/scan`, { method: "POST" }),
  scanStatus: (key: string) => request<{ scanning: boolean; processed: number; total: number; errors: number; message: string }>(`/libraries/${encodeURIComponent(key)}/scan/status`),
};

export const bookFileUrl = (id: number) => `/api/v1/publications/${id}/file`;
export const coverUrl = (book: PublicationSummary) => book.cover_url ? `${book.cover_url}` : undefined;
