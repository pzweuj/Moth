import { beforeEach, describe, expect, it } from "vitest";
import { loadComicSettings, saveComicSettings } from "./comicSettings";

beforeEach(() => {
  localStorage.clear();
});

describe("comic settings persistence", () => {
  it("defaults to a screen-fitted image", () => {
    expect(loadComicSettings()).toEqual({ mode: "fit-screen", scale: 100 });
  });

  it("normalizes legacy and out-of-range values", () => {
    localStorage.setItem("moth:comic-settings", JSON.stringify({ mode: "custom", scale: 317 }));
    expect(loadComicSettings()).toEqual({ mode: "custom", scale: 300 });

    localStorage.setItem("moth:comic-settings", JSON.stringify({ mode: "unknown", scale: 43 }));
    expect(loadComicSettings()).toEqual({ mode: "fit-screen", scale: 50 });
  });

  it("rounds custom zoom to ten percent steps", () => {
    saveComicSettings({ mode: "custom", scale: 126 });
    expect(loadComicSettings()).toEqual({ mode: "custom", scale: 130 });
  });
});
