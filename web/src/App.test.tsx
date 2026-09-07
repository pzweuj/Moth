import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204) {
  return new Response(null, { status });
}

describe("Moth authentication shell", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes an uninitialized server to setup", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ initialized: false }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "打造你的阅读空间。" })).toBeInTheDocument();
    expect(screen.getByLabelText("用户名")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建账户" })).toBeInTheDocument();
  });

  it("shows login for an initialized server and displays API errors", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/setup/status")) return Promise.resolve(jsonResponse({ initialized: true }));
      if (path.endsWith("/session") && (!init?.method || init.method === "GET")) {
        return Promise.resolve(jsonResponse({ authenticated: false }));
      }
      if (path.endsWith("/session") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ error: { code: "invalid_credentials", message: "Invalid username or password" } }, 401));
      }
      return Promise.resolve(jsonResponse({ status: "ok", version: "0.1.0", database: "ok" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "继续上次阅读。" })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("用户名"), "moth");
    await user.type(screen.getByLabelText("密码"), "wrong password");
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("用户名或密码错误");
  });

  it("initializes, signs in, and opens the protected home", async () => {
    let initialized = false;
    let authenticated = false;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/setup/status")) return Promise.resolve(jsonResponse({ initialized }));
      if (path.endsWith("/session") && init?.method === "POST") {
        authenticated = true;
        return Promise.resolve(emptyResponse());
      }
      if (path.endsWith("/session")) return Promise.resolve(jsonResponse({ authenticated, username: authenticated ? "moth" : undefined }));
      if (path.endsWith("/books")) return Promise.resolve(jsonResponse([]));
      if (path.endsWith("/library/scan/status")) return Promise.resolve(jsonResponse({ scanning: false, processed: 0, total: 0, errors: 0, message: "" }));
      return Promise.resolve(jsonResponse({ status: "ok", version: "0.1.0", database: "ok" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "打造你的阅读空间。" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("用户名"), "moth");
    await user.type(screen.getByLabelText("密码"), "a secure password");
    await user.type(screen.getByLabelText("确认密码"), "a secure password");
    initialized = true;
    await user.click(screen.getByRole("button", { name: "创建账户" }));

    expect(await screen.findByRole("heading", { name: "我的书库" })).toBeInTheDocument();
    expect(screen.getByText("欢迎回来，moth")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/session", expect.objectContaining({ method: "POST" })));
  });

  it("signs out the current session and returns to login", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/setup/status")) return Promise.resolve(jsonResponse({ initialized: true }));
      if (path.endsWith("/session") && init?.method === "DELETE") return Promise.resolve(emptyResponse());
      if (path.endsWith("/session")) return Promise.resolve(jsonResponse({ authenticated: true, username: "moth" }));
      if (path.endsWith("/books")) return Promise.resolve(jsonResponse([]));
      if (path.endsWith("/library/scan/status")) return Promise.resolve(jsonResponse({ scanning: false, processed: 0, total: 0, errors: 0, message: "" }));
      return Promise.resolve(jsonResponse({ status: "ok", version: "0.1.0", database: "ok" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "我的书库" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "退出登录" }));
    expect(await screen.findByRole("heading", { name: "继续上次阅读。" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/session", expect.objectContaining({ method: "DELETE" }));
  });
});
