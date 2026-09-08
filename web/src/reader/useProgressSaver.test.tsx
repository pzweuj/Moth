import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProgressSaver } from "./useProgressSaver";

const { saveProgress } = vi.hoisted(() => ({ saveProgress: vi.fn() }));

vi.mock("../api", () => ({ api: { saveProgress } }));

function Harness() {
  const saver = useProgressSaver({ publicationId: 7, contentVersion: "v1" });
  return <><button type="button" onClick={() => saver.save({ type: "cbz", page_index: 1, page_progress: 0, progress: 0.5 })}>save one</button><button type="button" onClick={() => saver.save({ type: "cbz", page_index: 2, page_progress: 0, progress: 0.75 })}>save two</button><button type="button" onClick={() => void saver.retry()}>retry</button><output role="status">{saver.error}</output></>;
}

function SwitchingHarness({ publicationId }: { publicationId: number }) {
  const saver = useProgressSaver({ publicationId, contentVersion: `v${publicationId}` });
  return <button type="button" onClick={() => saver.save({ type: "cbz", page_index: publicationId, page_progress: 0, progress: 0.5 })}>save</button>;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useProgressSaver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saveProgress.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("debounces rapid updates to the latest position", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "save one" }));
    fireEvent.click(screen.getByRole("button", { name: "save two" }));
    await act(async () => { vi.advanceTimersByTime(449); });
    expect(saveProgress).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    await settle();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(saveProgress.mock.calls[0][0]).toBe(7);
    expect(saveProgress.mock.calls[0][1].position.page_index).toBe(2);
  });

  it("flushes on unmount and retries a failed write", async () => {
    saveProgress.mockRejectedValueOnce(new Error("offline"));
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "save one" }));
    await act(async () => { vi.advanceTimersByTime(450); });
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("进度保存失败");
    // The failed request remains dirty and a retry sends the same latest value.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "retry" })); });
    await settle();
    expect(saveProgress).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "save two" }));
    view.unmount();
    await settle();
    expect(saveProgress).toHaveBeenCalledTimes(3);
    expect(saveProgress.mock.calls[2][1].position.page_index).toBe(2);
  });

  it("flushes the previous publication when the reader route changes", async () => {
    const view = render(<SwitchingHarness publicationId={7} />);
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    view.rerender(<SwitchingHarness publicationId={8} />);
    await settle();
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(saveProgress.mock.calls[0][0]).toBe(7);
    expect(saveProgress.mock.calls[0][1].position.page_index).toBe(7);
  });
});
