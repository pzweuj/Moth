import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type BrowseResponse, type HomeResponse, type PublicationSummary, type ScanStatus } from "../api";
import { LibraryPage } from "./LibraryPage";
import { LibraryPageCache } from "./useLibraryData";

const book: PublicationSummary = {
  id: 1, title: "第一卷", author: null, filename: "01.txt", directory_path: "文学/系列",
  source_format: "txt", reader_format: "txt", progress: 0.1, content_version: "v1", file_size: 1, parse_status: "ok",
};
const home: HomeResponse = { continue_reading: [book], directories: [], hidden_directories: [] };
const idle: ScanStatus = { scanning: false, discovery_complete: true, processed: 12, total: 12, errors: 0, message: "" };
const directory = (path: string): BrowseResponse => ({ path, breadcrumbs: [{ name: path, path }], directories: [], publications: [{ ...book, title: `${path}的书`, directory_path: path }], publication_count: 1, directory_count: 1 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function ReaderReturn() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>返回书库</button>;
}

function renderLibrary(cache = new LibraryPageCache(), path = "/") {
  return render(<MemoryRouter initialEntries={[path]}>
    <Link to="/browse?view=browse&path=B">切换到B</Link>
    <Routes>
      <Route path="/reader/:id" element={<ReaderReturn />} />
      <Route path="*" element={<LibraryPage cache={cache} theme="light" onToggleTheme={vi.fn()} onLogout={vi.fn()} />} />
    </Routes>
  </MemoryRouter>);
}

beforeEach(() => {
  vi.spyOn(api, "home").mockResolvedValue(home);
  vi.spyOn(api, "browse").mockImplementation(async path => directory(path ?? ""));
  vi.spyOn(api, "scanStatus").mockResolvedValue(idle);
  vi.spyOn(api, "scan").mockResolvedValue(undefined);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("library navigation", () => {
  it("shows content without waiting for scan status and never labels a normal load as scanning", async () => {
    const pendingHome = deferred<HomeResponse>();
    const pendingScan = deferred<ScanStatus>();
    vi.mocked(api.home).mockReturnValue(pendingHome.promise);
    vi.mocked(api.scanStatus).mockReturnValue(pendingScan.promise);
    renderLibrary();
    expect(screen.queryByText(/正在(读取|扫描)书库/)).not.toBeInTheDocument();
    expect(screen.queryByText("这里还没有目录。")).not.toBeInTheDocument();
    await act(async () => { pendingHome.resolve(home); });
    expect(screen.getByRole("link", { name: /第一卷/ })).toBeInTheDocument();
    expect(api.scan).not.toHaveBeenCalled();
    await act(async () => { pendingScan.resolve(idle); });
    expect(screen.queryByText("最近扫描")).not.toBeInTheDocument();
  });

  it("restores the library immediately after leaving the reader and refreshes progress in the background", async () => {
    renderLibrary();
    fireEvent.click(await screen.findByRole("link", { name: /第一卷/ }));
    const update = deferred<HomeResponse>();
    vi.mocked(api.home).mockReturnValueOnce(update.promise);
    fireEvent.click(screen.getByRole("button", { name: "返回书库" }));
    expect(screen.getByRole("link", { name: /第一卷/ })).toBeInTheDocument();
    expect(screen.queryByText(/正在(读取|扫描)书库/)).not.toBeInTheDocument();
    await act(async () => { update.resolve({ ...home, continue_reading: [{ ...book, progress: 0.85 }] }); });
    expect(screen.getByText("85% · 文学/系列")).toBeInTheDocument();
    expect(api.home).toHaveBeenCalledTimes(2);
    expect(api.scan).not.toHaveBeenCalled();
  });

  it("aborts the previous directory and ignores its late response", async () => {
    const cache = new LibraryPageCache();
    const previous = deferred<BrowseResponse>();
    vi.mocked(api.browse).mockImplementation(path => path === "A" ? previous.promise : Promise.resolve(directory("B")));
    renderLibrary(cache, "/browse?view=browse&path=A");
    const signal = vi.mocked(api.browse).mock.calls[0][1];
    fireEvent.click(screen.getByRole("link", { name: "切换到B" }));
    await screen.findByRole("link", { name: /B的书/ });
    expect(signal?.aborted).toBe(true);
    await act(async () => { previous.resolve(directory("A")); });
    expect(screen.queryByText("A的书")).not.toBeInTheDocument();
    expect(cache.get("browse:A")).toBeNull();
    expect(api.scanStatus).toHaveBeenCalledTimes(1);
  });

  it("keeps a cached directory visible on refresh failure and supports retry", async () => {
    const cache = new LibraryPageCache();
    cache.set("browse:A", { kind: "browse", value: directory("A") });
    vi.mocked(api.browse).mockRejectedValueOnce(new Error("网络连接失败"));
    renderLibrary(cache, "/browse?view=browse&path=A");
    expect(screen.getByRole("link", { name: /A的书/ })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("网络连接失败");
    expect(screen.getByRole("link", { name: /A的书/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await act(async () => {});
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.browse).toHaveBeenCalledTimes(2);
  });

  it("does not repopulate cleared session data from an in-flight request", async () => {
    const cache = new LibraryPageCache();
    const pending = deferred<HomeResponse>();
    vi.mocked(api.home).mockReturnValue(pending.promise);
    renderLibrary(cache);
    cache.clear();
    await act(async () => { pending.resolve(home); });
    expect(cache.get("home")).toBeNull();
    expect(screen.queryByText("第一卷")).not.toBeInTheDocument();
  });

  it("shows genuine scan progress without clearing books, then refreshes on completion", async () => {
    vi.useFakeTimers();
    renderLibrary();
    await act(async () => {});
    vi.mocked(api.scanStatus).mockResolvedValueOnce({ ...idle, scanning: true });
    fireEvent.click(screen.getByRole("button", { name: "重新扫描" }));
    await act(async () => {});
    expect(api.scan).toHaveBeenCalledTimes(1);
    expect(screen.getByText("扫描进度")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /第一卷/ })).toBeInTheDocument();
    const updated = deferred<HomeResponse>();
    vi.mocked(api.home).mockReturnValueOnce(updated.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByRole("link", { name: /第一卷/ })).toBeInTheDocument();
    expect(screen.queryByText("最近扫描")).not.toBeInTheDocument();
    await act(async () => { updated.resolve({ ...home, continue_reading: [{ ...book, title: "扫描后的书" }] }); });
    expect(screen.getByRole("link", { name: /扫描后的书/ })).toBeInTheDocument();
  });
});
