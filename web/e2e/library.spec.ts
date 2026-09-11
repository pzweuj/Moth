import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { HomeResponse } from "../src/api";

// These checks control API timing; service-worker activation/reload has its own tests.
test.use({ serviceWorkers: "block" });

const book = { id: 1, title: "测试第一卷", filename: "01.cbz", directory_path: "文学/系列", source_format: "cbz" as const, reader_format: "cbz" as const, author: null, progress: 0.1, content_version: "v1", file_size: 1, parse_status: "ok" };
const home: HomeResponse = {
  continue_reading: [book], hidden_directories: [],
  directories: [{ name: "文学", path: "文学", series: Array.from({ length: 40 }, (_, i) => ({ name: `系列 ${i + 1}`, path: `文学/系列${i + 1}`, publication_count: 1, representative: book })) }],
};

async function mockLibrary(page: Page, readHome: () => Promise<HomeResponse> = async () => home) {
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    const respond = (json: unknown) => route.fulfill({ json });
    switch (url.pathname) {
      case "/api/v1/setup/status": return respond({ initialized: true });
      case "/api/v1/session": return respond({ authenticated: true, username: "reader" });
      case "/api/v1/scan/status": return respond({ scanning: false, discovery_complete: true, processed: 40, total: 40, errors: 0, message: "" });
      case "/api/v1/home": return respond(await readHome());
      case "/api/v1/browse": {
        const path = url.searchParams.get("path") ?? "";
        return respond({
          path, breadcrumbs: [{ name: "目录", path: "" }, ...(path ? [{ name: path, path }] : [])],
          directories: Array.from({ length: 40 }, (_, i) => ({ name: `目录 ${i + 1}`, path: `${path}/目录${i + 1}`, publication_count: 1, child_directory_count: 2 })),
          publications: [book], publication_count: 1, directory_count: 40,
        });
      }
      case "/api/v1/publications/1/progress": return respond(null);
      case "/api/v1/publications/1": return respond({ ...book, chapters: [], pages: [{ idx: 0, path: "0.svg", mime: "image/svg+xml", width: 400, height: 600 }] });
      case "/api/v1/publications/1/pages/0": return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#ddd"/></svg>' });
      default: return route.fulfill({ status: 404 });
    }
  });
}

test("library buttons and search stay at the top on every library route", async ({ page, app }) => {
  await mockLibrary(page);
  for (const path of ["/", "/browse?view=browse", "/browse?view=browse&path=文学", "/browse?view=browse&path=文学/系列"]) {
    await page.goto(`${app.url}${path}`);
    await expect(page.locator(".library-body .series-card, .library-body .directory-card").first()).toBeVisible();
    const nav = page.locator(".home-nav");
    const search = page.getByRole("searchbox");
    const beforeNav = (await nav.boundingBox())!;
    const beforeSearch = (await search.boundingBox())!;
    await page.evaluate(() => window.scrollTo(0, 800));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    expect(Math.abs((await nav.boundingBox())!.y - beforeNav.y)).toBeLessThan(1);
    expect(Math.abs((await search.boundingBox())!.y - beforeSearch.y)).toBeLessThan(1);
    await expect(search).toBeVisible();
    await page.getByLabel("包含隐藏书架").check();
    await expect(page.getByLabel("包含隐藏书架")).toBeChecked();
    await page.getByRole("button", { name: "切换主题" }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("returning from the reader keeps books visible while the server refresh is pending", async ({ page, app }) => {
  let holdRefresh = false;
  let requests = 0;
  let release!: () => void;
  const refresh = new Promise<void>(resolve => { release = resolve; });
  await mockLibrary(page, async () => {
    if (!holdRefresh) return home;
    requests += 1;
    await refresh;
    return { ...home, continue_reading: [{ ...book, title: "刷新后的第一卷", progress: 0.85 }] };
  });
  try {
    await page.goto(app.url);
    await page.getByRole("link", { name: /测试第一卷/ }).first().click();
    await expect(page.locator(".comic-pages img")).toBeVisible();
    holdRefresh = true;
    await page.goBack();
    await expect.poll(() => requests).toBe(1);
    await expect(page.getByRole("link", { name: /测试第一卷/ }).first()).toBeVisible();
    await expect(page.getByText(/正在(读取|扫描)书库/)).toHaveCount(0);
    await expect(page.getByText("最近扫描")).toHaveCount(0);
    release();
    await expect(page.getByRole("link", { name: /刷新后的第一卷/ })).toBeVisible();
    await expect(page.getByText("85% · 文学/系列")).toBeVisible();
  } finally { release(); }
});
