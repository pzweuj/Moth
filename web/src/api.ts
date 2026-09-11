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
  directory_path: string;
  parse_status: string;
};

export type BookDetail = PublicationSummary & {
  chapters: Array<{ idx: number; title: string; character_count: number }>;
  pages: Array<{ idx: number; path: string; mime: string; width?: number; height?: number }>;
};

export type DirectorySummary = { name: string; path: string; child_directory_count: number; publication_count: number };
export type BrowseResponse = {
  path: string;
  breadcrumbs: Array<{ name: string; path: string }>;
  directories: DirectorySummary[];
  publications: PublicationSummary[];
  publication_count: number;
  directory_count: number;
};
export type HomeSeriesPreview = { name: string; path: string; publication_count: number; representative: PublicationSummary | null };
export type HomeDirectoryPreview = { name: string; path: string; series: HomeSeriesPreview[] };
export type HiddenDirectorySummary = { name: string; path: string };
export type HomeResponse = { continue_reading: PublicationSummary[]; directories: HomeDirectoryPreview[]; hidden_directories: HiddenDirectorySummary[] };
export type SearchDirectoryItem = {
  name: string;
  path: string;
  parent_path: string | null;
  child_directory_count: number;
  publication_count: number;
};
export type SearchGroup<T> = { items: T[]; total: number; has_more: boolean };
export type SearchResponse = {
  shelves: SearchGroup<SearchDirectoryItem>;
  series: SearchGroup<SearchDirectoryItem>;
  books: SearchGroup<PublicationSummary>;
};
export type ChapterContent = { idx: number; title: string; content: string; text: string; encoding: string; content_version: string; character_count: number };
export type ConversionResponse = { status: "pending" | "preparing" | "ready" | "failed" | "not_required"; file_url?: string; error?: string };
export type ScanStatus = { scanning: boolean; discovery_complete: boolean; processed: number; total: number; errors: number; message: string };

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "ApiError"; this.status = status; this.code = code; }
}

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  const parentSignal = init.signal;
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener("abort", abort, { once: true });
  }
  try { return await fetch(input, { ...init, signal: controller.signal, credentials: "same-origin" }); }
  finally {
    window.clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abort);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetchWithTimeout(`/api/v1${path}`, { ...init, headers });
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
  home: (signal?: AbortSignal) => request<HomeResponse>("/home", { signal }),
  browse: (path = "", signal?: AbortSignal) => request<BrowseResponse>(`/browse?path=${encodeURIComponent(path)}`, { signal }),
  search: (query: string, includeHidden = false, kind: "all" | "shelves" | "series" | "books" = "all", offset = 0, limit = 20, signal?: AbortSignal) => request<SearchResponse>(`/search?q=${encodeURIComponent(query)}&include_hidden=${includeHidden ? "true" : "false"}&kind=${kind}&offset=${offset}&limit=${limit}`, { signal }),
  book: (id: number, encoding?: string, signal?: AbortSignal) => request<BookDetail>(`/publications/${id}${encoding ? `?encoding=${encodeURIComponent(encoding)}` : ""}`, { signal }),
  progress: (id: number, signal?: AbortSignal) => request<ProgressBody | null>(`/publications/${id}/progress`, { signal }),
  saveProgress: (id: number, value: ProgressBody, options: { keepalive?: boolean } = {}) => request<ProgressBody>(`/publications/${id}/progress`, { method: "PUT", body: JSON.stringify(value), keepalive: options.keepalive }),
  chapter: (id: number, index: number, encoding?: string, signal?: AbortSignal) => request<ChapterContent>(`/publications/${id}/chapters/${index}${encoding ? `?encoding=${encodeURIComponent(encoding)}` : ""}`, { signal }),
  conversion: (id: number, signal?: AbortSignal) => request<ConversionResponse>(`/publications/${id}/conversion`, { signal }),
  startConversion: (id: number, signal?: AbortSignal) => request<ConversionResponse>(`/publications/${id}/conversion`, { method: "POST", signal }),
  scan: () => request<void>("/scan", { method: "POST" }),
  scanStatus: (signal?: AbortSignal) => request<ScanStatus>("/scan/status", { signal }),
};

export const bookFileUrl = (id: number) => `/api/v1/publications/${id}/file`;
export const pageThumbnailUrl = (id: number, page: number) => `/api/v1/publications/${id}/pages/${page}/thumbnail`;
