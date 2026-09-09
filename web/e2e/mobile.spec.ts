import { test, expect, login, waitForScan } from "./fixtures";

type HomePublication = { id: number; source_format: string; reader_format: string };

async function homePublications(page: Parameters<typeof login>[0], url: string): Promise<HomePublication[]> {
  const home = await (await page.request.get(`${url}/api/v1/home`)).json() as { directories: Array<{ series: Array<{ representative: HomePublication | null }> }> };
  return home.directories.flatMap((directory) => directory.series.flatMap((series) => series.representative ? [series.representative] : []));
}

test("mobile text reader uses compact chrome and a collapsible chapter drawer", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  const txt = (await homePublications(page, app.url)).find((publication) => publication.source_format === "txt");
  expect(txt).toBeTruthy();
  await page.goto(`${app.url}/reader/${txt!.id}`);
  await expect(page.locator(".reader-clock")).toHaveText(/^\d{2}:\d{2}$/);
  const themeButton = page.getByRole("button", { name: "切换主题", exact: true });
  await expect(themeButton).toBeVisible();
  const initialTheme = await page.locator("html").getAttribute("data-theme");
  await themeButton.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", initialTheme === "dark" ? "light" : "dark");
  await themeButton.click();
  const headerSpacing = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right } : null;
    };
    const clock = bounds(".reader-clock");
    const theme = bounds(".reader-theme-button");
    const settings = bounds(".reader-titlebar .reader-icon-button[aria-label='阅读设置']");
    return { clock, theme, settings };
  });
  expect(headerSpacing.clock && headerSpacing.theme && headerSpacing.settings).toBeTruthy();
  expect(headerSpacing.theme!.left - headerSpacing.clock!.right).toBeGreaterThanOrEqual(9);
  expect(headerSpacing.settings!.left - headerSpacing.theme!.right).toBeGreaterThanOrEqual(5);
  await expect(page.locator(".reader-bottom-bar")).toBeHidden();
  await expect(page.locator(".reader-tools")).toHaveCount(0);
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await expect(page.locator(".reader-tools")).toBeVisible();
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await expect(page.locator(".reader-tools")).toHaveCount(0);
  await page.getByRole("button", { name: "打开章节", exact: true }).click();
  await expect(page.locator(".reader-drawer")).toBeVisible();
  await expect(page.locator(".reader-navigation-item").first()).toBeVisible();
});

test("mobile CBZ reader exposes lazy page thumbnails and no bottom pager", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  const cbz = (await homePublications(page, app.url)).find((publication) => publication.source_format === "cbz");
  expect(cbz).toBeTruthy();
  await page.goto(`${app.url}/reader/${cbz!.id}`);
  await expect(page.locator(".reader-bottom-bar")).toBeHidden();
  const content = page.locator(".comic-reader .reader-content");
  const scrollbar = await content.evaluate((node) => {
    const style = getComputedStyle(node);
    const webkit = getComputedStyle(node, "::-webkit-scrollbar");
    return { scrollbarWidth: style.scrollbarWidth, webkitDisplay: webkit.display };
  });
  expect(scrollbar.scrollbarWidth === "none" || scrollbar.webkitDisplay === "none").toBe(true);
  await page.getByRole("button", { name: "打开页码", exact: true }).click();
  await expect(page.locator(".reader-page-drawer")).toBeVisible();
  await expect(page.locator(".reader-page-drawer img").first()).toHaveAttribute("src", /thumbnail/);
});
