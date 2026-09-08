import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings, type ReaderSettings } from "./settings";

const KEY = "moth:reader-settings";

beforeEach(() => {
  localStorage.clear();
});

describe("reader settings persistence", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual({
      fontSize: 18,
      lineHeight: 1.7,
      theme: "light",
      flow: "paginated",
    });
  });

  it("round-trips saved settings", () => {
    const settings: ReaderSettings = {
      fontSize: 22,
      lineHeight: 2.0,
      theme: "dark",
      flow: "scrolled",
    };
    saveSettings(settings);
    expect(loadSettings()).toEqual(settings);
  });

  it("merges partial stored settings over defaults", () => {
    localStorage.setItem(KEY, JSON.stringify({ fontSize: 24 }));
    const settings = loadSettings();
    expect(settings.fontSize).toBe(24);
    expect(settings.lineHeight).toBe(1.7);
    expect(settings.theme).toBe("light");
  });

  it("falls back to defaults on corrupt storage", () => {
    localStorage.setItem(KEY, "not-json");
    expect(loadSettings()).toEqual({
      fontSize: 18,
      lineHeight: 1.7,
      theme: "light",
      flow: "paginated",
    });
  });

  it("survives a throwing localStorage", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => saveSettings({ ...loadSettings(), theme: "dark" })).not.toThrow();
    spy.mockRestore();
  });
});
