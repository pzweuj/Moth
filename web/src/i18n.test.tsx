import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { AppearanceControls } from "./ui/AppearanceControls";
import { readPreferences, translateError, UiProvider, useUi } from "./i18n";

function Probe() {
  const { t } = useUi();
  return <p>{translateError(new ApiError(404, "not_found", "ignored"), t)}</p>;
}

describe("localized UI preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.lang = "zh-CN";
    delete document.documentElement.dataset.theme;
    document.title = "";
  });

  it("starts in Chinese and persists an English dark-mode choice", async () => {
    const user = userEvent.setup();
    render(
      <UiProvider>
        <AppearanceControls />
      </UiProvider>,
    );

    expect(screen.getByRole("button", { name: "中文" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "EN" }));
    await user.click(screen.getByRole("button", { name: "Dark mode" }));

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en");
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.title).toBe("Moth · Personal library");
    });
    expect(JSON.parse(localStorage.getItem("moth:ui-preferences") ?? "{}")).toEqual({ locale: "en", theme: "dark" });
  });

  it("migrates the legacy reader theme without overriding an explicit site choice", () => {
    localStorage.setItem("moth:reader-settings", JSON.stringify({ theme: "dark" }));
    expect(readPreferences()).toEqual({ locale: "zh-CN", theme: "dark" });

    localStorage.setItem("moth:reader-settings", JSON.stringify({ theme: "sepia" }));
    expect(readPreferences()).toEqual({ locale: "zh-CN", theme: "light" });

    localStorage.setItem("moth:ui-preferences", JSON.stringify({ locale: "en", theme: "light" }));
    expect(readPreferences()).toEqual({ locale: "en", theme: "light" });
  });

  it("maps stable API error codes in the active language", () => {
    render(
      <UiProvider>
        <Probe />
      </UiProvider>,
    );
    expect(screen.getByText("找不到请求的内容。")).toBeInTheDocument();
  });
});
