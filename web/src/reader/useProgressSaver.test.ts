import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type ProgressBody } from "../api";
import { useProgressSaver } from "./useProgressSaver";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      putProgress: vi.fn(),
    },
  };
});

const putProgress = vi.mocked(api.putProgress);

function flushTimers() {
  act(() => {
    vi.runAllTimers();
  });
}

describe("useProgressSaver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    putProgress.mockReset();
    putProgress.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("debounces saves and keeps only the latest location", async () => {
    const { result } = renderHook(() => useProgressSaver(7));
    const progress: ProgressBody = { chapter_index: 0, page_index: 1, percent: 12.5 };

    act(() => {
      result.current.onProgress(progress);
      result.current.onProgress({ ...progress, page_index: 2, percent: 25 });
    });
    expect(putProgress).not.toHaveBeenCalled();
    flushTimers();
    expect(putProgress).toHaveBeenCalledTimes(1);
    expect(putProgress).toHaveBeenCalledWith(7, {
      chapter_index: 0,
      page_index: 2,
      percent: 25,
    });
    await vi.waitFor(() => expect(result.current.saveState).toBe("saved"));
  });

  it("flushes pending progress on unmount", () => {
    const { result, unmount } = renderHook(() => useProgressSaver(7));
    const progress: ProgressBody = { chapter_index: 1, page_index: 0, percent: 50 };

    act(() => {
      result.current.onProgress(progress);
    });
    unmount();
    expect(putProgress).toHaveBeenCalledTimes(1);
    expect(putProgress).toHaveBeenCalledWith(7, progress);
  });

  it("reports failure without clearing the pending payload", async () => {
    putProgress.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useProgressSaver(7));
    const progress: ProgressBody = { chapter_index: 0, page_index: 0, percent: 1 };

    act(() => {
      result.current.onProgress(progress);
    });
    flushTimers();
    await vi.waitFor(() => expect(result.current.saveState).toBe("error"));

    // The next save retries the same latest location.
    putProgress.mockResolvedValueOnce(undefined);
    act(() => {
      result.current.onProgress({ ...progress, page_index: 1, percent: 2 });
    });
    flushTimers();
    expect(putProgress).toHaveBeenLastCalledWith(7, {
      chapter_index: 0,
      page_index: 1,
      percent: 2,
    });
    await vi.waitFor(() => expect(result.current.saveState).toBe("saved"));
  });

  it("distinguishes an expired session from a transport failure", async () => {
    putProgress.mockRejectedValueOnce(new ApiError(401, "invalid_credentials", "Sign in again"));
    const { result } = renderHook(() => useProgressSaver(7));
    act(() => {
      result.current.onProgress({ chapter_index: 0, page_index: 0, percent: 1 });
    });
    flushTimers();
    await vi.waitFor(() => expect(result.current.saveState).toBe("needs-login"));
  });
});
