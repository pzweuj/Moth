export type SetupStatus = {
  initialized: boolean;
};

export type SessionState = {
  authenticated: boolean;
  username?: string;
};

export type BookSummary = {
  id: number;
  title: string;
  author?: string;
  format: "epub" | "txt" | "cbz" | "mobi";
  has_cover: boolean;
  cover_url?: string;
  page_count: number;
  parse_status: "ok" | "error";
  percent: number;
};

export type ChapterInfo = {
  idx: number;
  title: string;
  /** Byte size of the rendered chapter content. */
  size: number;
};

export type ProgressBody = {
  chapter_index: number;
  page_index: number;
  percent: number;
};

export type BookDetail = BookSummary & {
  parse_error?: string;
  chapters: ChapterInfo[];
  progress?: ProgressBody;
};

export type ChapterContent = {
  idx: number;
  title: string;
  content: string;
};

export type ScanStatus = {
  scanning: boolean;
  processed: number;
  total: number;
  errors: number;
  message: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  if (!response.ok) {
    let code = "request_failed";
    let message = "Something went wrong. Please try again.";
    try {
      const payload = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      code = payload.error?.code ?? code;
      message = payload.error?.message ?? message;
    } catch {
      // Keep the safe generic message when the server did not return JSON.
    }
    throw new ApiError(response.status, code, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  getSetupStatus: () => request<SetupStatus>("/setup/status"),
  setup: (username: string, password: string) =>
    request<SetupStatus>("/setup", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<void>("/session", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  getSession: () => request<SessionState>("/session"),
  logout: () => request<void>("/session", { method: "DELETE" }),
  getBooks: () => request<BookSummary[]>("/books"),
  getBook: (id: number) => request<BookDetail>(`/books/${id}`),
  getChapter: (id: number, idx: number, encoding?: string) =>
    request<ChapterContent>(
      `/books/${id}/chapter/${idx}${encoding ? `?encoding=${encodeURIComponent(encoding)}` : ""}`,
    ),
  getProgress: (id: number) => request<ProgressBody>(`/books/${id}/progress`),
  putProgress: (id: number, progress: ProgressBody) =>
    request<void>(`/books/${id}/progress`, {
      method: "PUT",
      body: JSON.stringify(progress),
    }),
  scanLibrary: () => request<void>("/library/scan", { method: "POST" }),
  getScanStatus: () => request<ScanStatus>("/library/scan/status"),
};

/** URL of a book's raw file, served with HTTP Range support. */
export const bookFileUrl = (id: number) => `/api/v1/books/${id}/file`;

