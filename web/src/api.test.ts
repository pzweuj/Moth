import { afterEach, describe, expect, it, vi } from "vitest";
import { api, fetchWithTimeout } from "./api";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("api client", () => {
  it("throws ApiError with the server error payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { error: { code: "invalid_credentials", message: "Invalid username or password" } },
          401,
        ),
      ),
    );

    await expect(api.login("moth", "nope")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      code: "invalid_credentials",
      message: "Invalid username or password",
    });
  });

  it("falls back to a safe message when the server does not return JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("gateway timeout", { status: 502 })),
    );

    await expect(api.getBooks()).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      code: "request_failed",
      message: "Something went wrong. Please try again.",
    });
  });

  it("treats 204 as an empty result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.putProgress(1, { chapter_index: 0, page_index: 0, percent: 1 })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/books/1/progress",
      expect.objectContaining({
        method: "PUT",
        headers: expect.any(Headers),
        credentials: "same-origin",
      }),
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("rejects non-JSON success responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    await expect(api.getBooks()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("aborts a server request that never responds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const rejection = expect(fetchWithTimeout("/api/v1/books/1/file", {}))
      .rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
