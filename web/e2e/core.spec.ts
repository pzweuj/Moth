import { test, expect, login, waitForScan } from "./fixtures";
import { unlink, writeFile } from "node:fs/promises";

type HomePublication = { id: number; title: string; source_format: string; reader_format: string; content_version?: string };

async function homePublications(page: Parameters<typeof login>[0], url: string): Promise<HomePublication[]> {
  const home = await (await page.request.get(`${url}/api/v1/home`)).json() as { directories: Array<{ series: Array<{ representative: HomePublication | null }> }> };
  return home.directories.flatMap((directory) => directory.series.flatMap((series) => series.representative ? [series.representative] : []));
}

async function readingFrame(page: Parameters<typeof login>[0], expected: string) {
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      try {
        if ((await frame.locator("body").innerText()).includes(expected)) return true;
      } catch {
        // The paginator can replace the iframe while a chapter is opening.
      }
    }
    return false;
  }, { timeout: 30_000 }).toBe(true);
  return page.frames().find((frame) => frame !== page.mainFrame() && frame.url() !== page.url()) ?? page.mainFrame();
}

test("home, directory browsing and service-worker shell", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  await expect(page.getByRole("heading", { name: "继续阅读", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "目录", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "英文", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /The Fixture Novel/ })).toBeVisible();
  await page.getByRole("link", { name: /The Fixture Novel/ }).click();
  await expect(page.locator("h1")).toHaveText("The Fixture Novel");
  await expect(page.locator(".book-card")).toHaveCount(2);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const caches = await page.evaluate(() => caches.keys());
  expect(caches.every((name) => name.startsWith("moth-shell-"))).toBe(true);
  expect(await page.evaluate(async () => (await caches.match("/api/v1/home")) !== undefined)).toBe(false);
});

test("TXT and CBZ readers use the online publication API", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  const home = await (await page.request.get(`${app.url}/api/v1/home`)).json() as { directories: Array<{ series: Array<{ representative: { id: number; source_format: string; title: string } | null }> }> };
  const publications = home.directories.flatMap((directory) => directory.series.flatMap((series) => series.representative ? [series.representative] : []));
  const txt = publications.find((publication) => publication.source_format === "txt");
  const cbz = publications.find((publication) => publication.source_format === "cbz");
  expect(txt).toBeTruthy();
  await page.goto(`${app.url}/reader/${txt!.id}`);
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await expect(page.getByLabel("编码", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeVisible();
  await expect.poll(async () => {
    const progress = await page.request.get(`${app.url}/api/v1/publications/${txt!.id}/progress`);
    return (await progress.json())?.position?.type ?? "";
  }).toBe("txt");
  await page.goto(`${app.url}/reader/${cbz!.id}`);
  await expect(page.locator(".comic-page img").first()).toHaveAttribute("src", /\/pages\/0/);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".comic-page img").first()).toHaveAttribute("src", /\/pages\/1/);
  await expect.poll(async () => page.locator(".comic-page img").first().evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await expect(page.getByLabel("漫画模式", { exact: true })).toBeVisible();
  await page.getByLabel("漫画模式", { exact: true }).selectOption("double");
  await page.getByLabel("漫画模式", { exact: true }).selectOption("webtoon");
});

test("hidden bookshelf is available through the collapsed more-shelves entry", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  const marker = `${app.books}/英文/hide`;
  await writeFile(marker, "");
  try {
    const home = await (await page.request.get(`${app.url}/api/v1/home`)).json() as {
      directories: Array<{ name: string }>;
      hidden_directories: Array<{ name: string; path: string }>;
    };
    expect(home.directories.some((directory) => directory.name === "英文")).toBe(false);
    expect(home.hidden_directories).toContainEqual({ name: "英文", path: "英文" });
    await page.reload();
    const more = page.locator(".hidden-directories");
    await expect(more).toBeVisible();
    await expect(more).not.toHaveAttribute("open");
    await expect(more.locator("summary")).toHaveText("更多书架");
    await more.locator("summary").click();
    const link = more.getByRole("link", { name: "英文", exact: true });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.locator("h1")).toHaveText("英文");
    await page.goBack();
    await expect(page.locator(".hidden-directories")).toBeVisible();
    await expect(page.locator(".hidden-directories")).not.toHaveAttribute("open");
  } finally {
    await unlink(marker);
  }
});

test("classic MOBI exposes conversion and EPUB reader format", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  const home = await (await page.request.get(`${app.url}/api/v1/home`)).json() as { directories: Array<{ series: Array<{ representative: { id: number; source_format: string; reader_format: string } | null }> }> };
  const publications = home.directories.flatMap((directory) => directory.series.flatMap((series) => series.representative ? [series.representative] : []));
  const mobi = publications.find((publication) => publication.source_format === "mobi");
  expect(mobi).toBeTruthy();
  expect(mobi!.reader_format).toBe("epub");
  const response = await page.request.post(`${app.url}/api/v1/publications/${mobi!.id}/conversion`);
  expect([200, 202]).toContain(response.status());
});

test("EPUB shows text and images, follows links, and repairs an invalid CFI", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  const epub = (await homePublications(page, app.url)).find((publication) => publication.source_format === "epub" && publication.title === "The Fixture Novel");
  expect(epub).toBeTruthy();
  const detail = await (await page.request.get(`${app.url}/api/v1/publications/${epub!.id}`)).json() as { content_version: string };

  await page.goto(`${app.url}/reader/${epub!.id}`);
  let frame = await readingFrame(page, "The adventure begins");
  await expect(frame.locator("h1")).toHaveText("Chapter One");
  await expect.poll(async () => frame.locator("img").evaluateAll((images) => images.filter((image) => image.complete && image.naturalWidth > 0).length)).toBeGreaterThan(0);

  await frame.getByRole("link", { name: "Continue to Chapter Two" }).click();
  frame = await readingFrame(page, "And then it continued");
  await expect(frame.locator("h1")).toHaveText("Chapter Two");

  await page.getByRole("button", { name: "打开章节", exact: true }).click();
  const chapters = page.locator(".reader-navigation-item");
  await expect(chapters).toHaveCount(2);
  await chapters.nth(0).click();
  frame = await readingFrame(page, "The adventure begins");
  await expect(frame.locator("h1")).toHaveText("Chapter One");
  await page.getByRole("button", { name: "打开章节", exact: true }).click();
  await page.locator(".reader-navigation-item").nth(1).click();
  frame = await readingFrame(page, "And then it continued");
  await expect(frame.locator("h1")).toHaveText("Chapter Two");
  await expect.poll(async () => {
    const response = await page.request.get(`${app.url}/api/v1/publications/${epub!.id}/progress`);
    const value = await response.json();
    return value?.position?.cfi ?? "";
  }).toMatch(/^epubcfi\(/);

  await page.goto(`${app.url}/reader/${epub!.id}`);
  frame = await readingFrame(page, "And then it continued");
  await expect(frame.locator("h1")).toHaveText("Chapter Two");

  // Leave the reader before injecting an invalid locator. Otherwise the
  // reader's pagehide keepalive save legitimately wins the race and restores
  // the old valid position over the fixture mutation.
  await page.goto(app.url);
  await page.request.put(`${app.url}/api/v1/publications/${epub!.id}/progress`, {
    data: {
      content_version: detail.content_version,
      position: { type: "epub", href: "missing.xhtml", cfi: "epubcfi(/999)", progress: 0 },
    },
  });
  await page.goto(`${app.url}/reader/${epub!.id}`);
  await readingFrame(page, "The adventure begins");
  await expect.poll(async () => {
    const response = await page.request.get(`${app.url}/api/v1/publications/${epub!.id}/progress`);
    const value = await response.json();
    return value?.position?.cfi ?? "";
  }).toMatch(/^epubcfi\(/);
});

test("TXT uses one heading, encoding-specific chapters, and keepalive recovery", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  const publications = await homePublications(page, app.url);
  const txt = publications.find((publication) => publication.source_format === "txt" && publication.title.includes("夜色入海"));
  const legacy = publications.find((publication) => publication.source_format === "txt" && publication.title.includes("Legacy GBK"));
  expect(txt).toBeTruthy();
  expect(legacy).toBeTruthy();

  const auto = await (await page.request.get(`${app.url}/api/v1/publications/${txt!.id}`)).json() as { content_version: string; chapters: Array<{ title: string }> };
  const explicit = await (await page.request.get(`${app.url}/api/v1/publications/${txt!.id}?encoding=utf-8`)).json() as { content_version: string; chapters: Array<{ title: string }> };
  expect(explicit.content_version).not.toBe(auto.content_version);
  expect(explicit.chapters.map((chapter) => chapter.title)).toEqual(auto.chapters.map((chapter) => chapter.title));
  const chapter = await (await page.request.get(`${app.url}/api/v1/publications/${txt!.id}/chapters/0?encoding=utf-8`)).json() as Record<string, unknown>;
  expect(chapter).not.toHaveProperty("content");
  expect(typeof chapter.text).toBe("string");
  const legacyBook = await (await page.request.get(`${app.url}/api/v1/publications/${legacy!.id}?encoding=gbk`)).json() as { chapters: Array<{ title: string }> };
  expect(legacyBook.chapters[0]?.title).toContain("Legacy GBK");

  await page.goto(`${app.url}/reader/${txt!.id}`);
  let frame = await readingFrame(page, "天亮了");
  const body = await frame.locator("body").innerText();
  expect(body.match(/第一章 夜色入海/g)?.length).toBe(1);
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.getByLabel("编码", { exact: true }).selectOption("utf-8");
  frame = await readingFrame(page, "天亮了");
  expect((await frame.locator("body").innerText()).match(/第一章 夜色入海/g)?.length).toBe(1);
  await page.getByRole("button", { name: "打开章节", exact: true }).click();
  await page.locator(".reader-navigation-item").filter({ hasText: "第二章 路上" }).click();
  const second = await readingFrame(page, "第二章 路上");
  expect((await second.locator("body").innerText()).match(/第二章 路上/g)?.length).toBe(1);

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(async () => {
    const response = await page.request.get(`${app.url}/api/v1/publications/${txt!.id}/progress`);
    const value = await response.json();
    return value?.position?.type ?? "";
  }).toBe("txt");
});

test("CBZ keeps page dimensions through double-page and Webtoon restore", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  const cbz = (await homePublications(page, app.url)).find((publication) => publication.source_format === "cbz");
  expect(cbz).toBeTruthy();
  const detail = await (await page.request.get(`${app.url}/api/v1/publications/${cbz!.id}`)).json() as { pages: Array<{ width?: number; height?: number }> };
  expect(detail.pages.length).toBeGreaterThan(2);
  expect(detail.pages.every((page) => (page.width ?? 0) > 0 && (page.height ?? 0) > 0)).toBe(true);

  await page.goto(`${app.url}/reader/${cbz!.id}`);
  await expect(page.locator(".comic-page img").first()).toBeVisible();
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.getByLabel("漫画模式", { exact: true }).selectOption("double");
  const doublePages = page.locator(".comic-page");
  await expect(doublePages).toHaveCount(2);
  const widths = await doublePages.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
  expect(Math.abs(widths[0] - widths[1])).toBeLessThan(2);

  await page.getByLabel("漫画模式", { exact: true }).selectOption("webtoon");
  await page.getByLabel("阅读方向", { exact: true }).selectOption("rtl");
  await expect(page.locator(".comic-reader")).toHaveAttribute("dir", "rtl");
  const content = page.locator(".comic-reader .reader-content");
  await expect.poll(async () => content.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await content.evaluate((node) => {
    node.scrollTop = node.scrollHeight * 0.65;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(async () => {
    const response = await page.request.get(`${app.url}/api/v1/publications/${cbz!.id}/progress`);
    const value = await response.json();
    return value?.position?.page_index ?? 0;
  }).toBeGreaterThan(0);
  await page.reload();
  await expect.poll(async () => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
});

test("classic MOBI conversion reaches a readable EPUB", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  const mobi = (await homePublications(page, app.url)).find((publication) => publication.source_format === "mobi");
  expect(mobi).toBeTruthy();
  const response = await page.request.post(`${app.url}/api/v1/publications/${mobi!.id}/conversion`);
  expect([200, 202]).toContain(response.status());
  await expect.poll(async () => {
    const status = await (await page.request.get(`${app.url}/api/v1/publications/${mobi!.id}/conversion`)).json() as { status: string };
    return status.status;
  }, { timeout: 30_000 }).toBe("ready");
  const file = await page.request.get(`${app.url}/api/v1/publications/${mobi!.id}/file`);
  expect(file.headers()["content-type"]).toContain("application/epub+zip");

  await page.goto(`${app.url}/reader/${mobi!.id}`);
  await readingFrame(page, "Project Gutenberg");
  await page.getByRole("button", { name: "打开章节", exact: true }).click();
  await page.locator(".reader-navigation-item").nth(3).click();
  const frame = await readingFrame(page, "Rabbit");
  expect(await frame.locator("body").innerText()).toContain("Pool of Tears");
});
