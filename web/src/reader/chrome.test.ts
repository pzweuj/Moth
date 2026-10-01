import { describe, expect, it } from "vitest";
import { chromeAfterCenterTap } from "./chrome";

const hidden = { mobile: true, toolbarVisible: false, settingsOpen: false, navigationOpen: false };

describe("reader center tap", () => {
  it("shows and hides the title bar on a phone", () => {
    const shown = chromeAfterCenterTap(hidden);
    expect(shown.toolbarVisible).toBe(true);
    expect(chromeAfterCenterTap(shown).toolbarVisible).toBe(false);
  });

  it("closes settings or the chapter drawer before hiding the title bar", () => {
    const settings = chromeAfterCenterTap({ ...hidden, toolbarVisible: true, settingsOpen: true });
    expect(settings).toMatchObject({ toolbarVisible: true, settingsOpen: false, navigationOpen: false });
    const chapters = chromeAfterCenterTap({ ...hidden, toolbarVisible: true, navigationOpen: true });
    expect(chapters).toMatchObject({ toolbarVisible: true, settingsOpen: false, navigationOpen: false });
  });

  it("leaves the desktop title bar alone", () => {
    const desktop = { mobile: false, toolbarVisible: true, settingsOpen: true, navigationOpen: false };
    expect(chromeAfterCenterTap(desktop)).toEqual(desktop);
  });
});
