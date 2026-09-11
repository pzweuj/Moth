import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComicReader } from "./ComicReader";
import type { BookDetail } from "../api";
import type { ComponentProps } from "react";

const detail = {
  id: 7,
  title: "测试漫画",
  author: null,
  source_format: "cbz",
  reader_format: "cbz",
  cover_url: undefined,
  progress: 0,
  content_version: "v1",
  file_size: 1,
  filename: "test.cbz",
  directory_path: "测试",
  parse_status: "ok",
  chapters: [],
  pages: [0, 1, 2].map((idx) => ({ idx, path: `${idx}.jpg`, mime: "image/jpeg", width: 100, height: 150 })),
} as BookDetail;

const settings = { mode: "single", direction: "ltr", fit: "screen" } as const;

describe("ComicReader page navigation", () => {
  it("loads a newly selected page without remounting", async () => {
    render(
      <ComicReader
        detail={detail}
        progress={null}
        settings={settings}
        navigationRequest={null}
        onCurrentPageChange={vi.fn()}
        onProgress={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByAltText("第 1 页")).toHaveAttribute("src", "/api/v1/publications/7/pages/0"));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(screen.getByAltText("第 2 页")).toHaveAttribute("src", "/api/v1/publications/7/pages/1"));
  });

  it("uses the outer left and right click zones for paginated CBZ pages", async () => {
    render(
      <ComicReader
        detail={detail}
        progress={null}
        settings={settings}
        navigationRequest={null}
        onCurrentPageChange={vi.fn()}
        onProgress={vi.fn()}
      />,
    );
    const stage = document.querySelector<HTMLDivElement>(".reader-content");
    expect(stage).toBeTruthy();
    stage!.getBoundingClientRect = () => ({ left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON: () => ({}) });

    await waitFor(() => expect(screen.getByAltText("第 1 页")).toBeInTheDocument());
    fireEvent.click(stage!, { clientX: 900 });
    await waitFor(() => expect(screen.getByAltText("第 2 页")).toBeInTheDocument());
    fireEvent.click(stage!, { clientX: 100 });
    await waitFor(() => expect(screen.getByAltText("第 1 页")).toBeInTheDocument());
  });

  it("handles jumps, odd final spreads, mode changes, retry and restored progress", () => {
    const onProgress = vi.fn();
    let props: ComponentProps<typeof ComicReader> = {
      detail, settings, navigationRequest: null, onCurrentPageChange: vi.fn(), onProgress,
      progress: { content_version: "v1", position: { type: "cbz", page_index: 1, page_progress: 0.4, progress: 1.4 / 3 } },
    };
    const { rerender } = render(<ComicReader {...props} />);
    expect(screen.getByAltText("第 2 页")).toBeInTheDocument();
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ page_index: 1, progress: 2 / 3 }));
    props = { ...props, settings: { ...settings, mode: "double" } };
    rerender(<ComicReader {...props} />);
    expect(screen.getByAltText("第 3 页")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    props = { ...props, navigationRequest: { id: "0", token: 1 } };
    rerender(<ComicReader {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getAllByRole("img")).toHaveLength(1);
    const last = screen.getByAltText("第 3 页");
    fireEvent.error(last);
    fireEvent.click(screen.getByRole("button", { name: "重试" }), { clientX: 999 });
    expect(screen.getByAltText("第 3 页")).toHaveAttribute("src", "/api/v1/publications/7/pages/2?retry=1");
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ page_index: 2 }));
    props = { ...props, settings };
    rerender(<ComicReader {...props} />);
    expect(screen.getByAltText("第 3 页")).toBeInTheDocument();
  });

  it("turns one spread per RTL touch and ignores its synthetic click", () => {
    render(<ComicReader detail={detail} settings={{ ...settings, direction: "rtl", mode: "double" }} navigationRequest={null} onProgress={vi.fn()} onCurrentPageChange={vi.fn()} />);
    const content = document.querySelector<HTMLDivElement>(".reader-content")!;
    content.getBoundingClientRect = () => ({ left: 0, right: 1000, top: 0, bottom: 700, width: 1000, height: 700 } as DOMRect);
    const touch = { identifier: 1, clientX: 100, clientY: 200 };
    fireEvent.touchStart(content, { touches: [touch], changedTouches: [touch] });
    fireEvent.touchEnd(content, { touches: [], changedTouches: [touch] });
    fireEvent.click(content, { clientX: 900, clientY: 200 });
    expect(screen.getByAltText("第 3 页")).toBeInTheDocument();
    expect(screen.queryByAltText("第 1 页")).not.toBeInTheDocument();
  });
});
