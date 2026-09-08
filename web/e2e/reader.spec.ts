import { test, expect, login, openBook, records, rendered, reloadOffline } from "./fixtures";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("TXT paginates, restores offline, synchronizes and clears content without losing progress", async ({ page, context, app }) => {
  await login(page, app.url);
  await openBook(page, "第一章 夜色入海");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect.poll(async () => Number((await page.locator(".reader-position").innerText()).replace("%", ""))).toBeGreaterThan(0);
  await expect.poll(async () => (await records(page, "chapters")).length).toBeGreaterThan(0);
  const before = await page.locator(".reader-position").innerText();
  await context.setOffline(true);
  await reloadOffline(page);
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await expect(page.locator(".reader-position")).toHaveText(before);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator(".save-indicator")).toHaveText("Saved on device");
  await expect.poll(async () => (await records(page, "queue")).length).toBeGreaterThan(0);
  await context.setOffline(false);
  await expect.poll(async () => (await records(page, "queue")).length).toBe(0);
  await page.getByRole("button", { name: "Your library" }).click();
  const progress = await records(page, "progressByContext");
  await page.getByRole("button", { name: "Clear cached content for 第一章 夜色入海", exact: true }).click();
  await expect.poll(async () => (await records(page, "chapters")).length).toBe(0);
  expect(await records(page, "progressByContext")).toEqual(progress);
});

test("EPUB renders safe content, nested TOC, settings and offline chapter resources", async ({ page, context, app }) => {
  const external: string[] = [];
  page.on("request", (r) => { if (r.url().includes("moth-fixture.invalid")) external.push(r.url()); });
  await login(page, app.url);
  await openBook(page, "The Fixture Novel");
  await expect.poll(async () => (await rendered(page)).heading).toBe("Chapter One");
  expect((await rendered(page)).active).toBe(0);
  await page.getByRole("button", { name: "Reader settings", exact: true }).click();
  await page.getByRole("button", { name: "Increase font size" }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await page.getByRole("button", { name: "Chapter Two", exact: true }).click();
  await expect.poll(async () => (await rendered(page)).heading).toBe("Chapter Two");
  await expect.poll(async () => (await records(page, "chapters")).length).toBeGreaterThanOrEqual(2);
  await context.setOffline(true);
  await reloadOffline(page);
  await expect.poll(async () => (await rendered(page)).heading).toBe("Chapter Two");
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await page.getByRole("button", { name: "Chapter One", exact: true }).click();
  await expect.poll(async () => (await rendered(page)).heading).toBe("Chapter One");
  await expect.poll(async () => (await rendered(page)).imageReady).toBe(true);
  expect(external).toEqual([]);
});

test("comic pages, zoom, touch navigation and uncached offline page feedback", async ({ page, context, app }) => {
  await login(page, app.url);
  await openBook(page, "晨光短篇");
  await expect(page.getByRole("img", { name: "Page 1 of 8", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reader settings", exact: true }).click();
  await page.getByRole("button", { name: "Fit width", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByRole("img", { name: "Page 2 of 8", exact: true })).toBeVisible();
  await context.setOffline(true);
  await reloadOffline(page);
  await expect(page.getByRole("img", { name: "Page 2 of 8", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator(".reader-error")).toBeVisible();
  await expect(page.locator(".reader-error")).toContainText(/something went wrong|not cached|connect|connection|online/i);
});

test("organization, appearance persistence, malformed books and logout cleanup", async ({ page, app }) => {
  await login(page, app.url);
  const noCover = (await (await page.request.get(`${app.url}/api/v1/books`)).json())
    .find((book: { title: string }) => book.title === "No Cover Novel");
  expect(noCover?.has_cover).toBe(false);
  await expect(page.getByRole("link", { name: "Read No Cover Novel", exact: true })
    .locator(".book-cover-placeholder")).toBeVisible();
  await page.getByRole("button", { name: "New section", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Sea stories");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => {
    const sections = await (await page.request.get(`${app.url}/api/v1/sections`)).json();
    return sections.some((section: { name: string }) => section.name === "Sea stories");
  }).toBe(true);
  await page.goto(`${app.url}/all`);
  await page.getByLabel("Select 第一章 夜色入海", { exact: true }).check();
  await page.getByLabel("Move selected books").selectOption({ label: "Sea stories" });
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(page.getByRole("region", { name: "Organize selected books" })).toHaveCount(0);
  await page.getByRole("button", { name: "Dark mode", exact: true }).click();
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "重新扫描书库", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByRole("link", { name: "Read Broken.epub", exact: true }).click();
  await expect(page.locator(".reader-error, .state-screen")).toBeVisible();
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  await openBook(page, "第一章 夜色入海");
  await expect.poll(async () => (await records(page, "chapters")).length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Your library" }).click();
  await page.evaluate(async () => { await (await caches.open("other-app")).put("/other-app", new Response("keep")); });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  const counts = await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    const counts: number[] = [];
    for (const entry of databases.filter((entry) => entry.name?.startsWith("moth-reader-v3-"))) {
      const db = await new Promise<IDBDatabase>((done) => { const r = indexedDB.open(entry.name!); r.onsuccess = () => done(r.result); });
      for (const name of ["chapters", "queue", "progressByContext"]) {
        counts.push(await new Promise<number>((done) => { const r = db.transaction(name).objectStore(name).count(); r.onsuccess = () => done(r.result); }));
      }
      db.close();
    }
    return counts;
  });
  expect(counts.length).toBeGreaterThan(0);
  expect(counts.every((count) => count === 0)).toBe(true);
  expect(await page.evaluate(async () => !!await caches.match("/other-app"))).toBe(true);
});

test("rescan changes content identity and TXT decoder preference survives reload", async ({ page, app }) => {
  await login(page, app.url);
  await openBook(page, "第一章 Legacy GBK");
  await page.getByRole("button", { name: "Reader settings", exact: true }).click();
  await page.getByLabel("Encoding", { exact: true }).selectOption("gbk");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(async () => (await records(page, "chapters")).some((c) => c.encoding === "gbk")).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "Reader settings", exact: true }).click();
  await expect(page.getByLabel("Encoding", { exact: true })).toHaveValue("gbk");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Your library" }).click();
  const before = await (await page.request.get(`${app.url}/api/v1/books`)).json();
  const book = before.find((b: { title: string }) => b.title === "第一章 夜色入海");
  await writeFile(join(app.books, "夜色入海.txt"), "第一章 新内容\n\n重新扫描后的内容。\n");
  await page.getByRole("button", { name: "Rescan library", exact: true }).click();
  await expect.poll(async () => {
    const books = await (await page.request.get(`${app.url}/api/v1/books`)).json();
    return books.find((b: { id: number }) => b.id === book.id)?.content_version;
  }).not.toBe(book.content_version);
});

test("a new Service Worker waits for the refresh action", async ({ page, app }) => {
  await login(page, app.url);
  const path = join(app.web, "sw.js");
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replace(/const VERSION = "[^"]+"/, 'const VERSION = "e2e-update"'));
  await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
  await expect(page.getByText("A new Moth version is ready.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await expect.poll(async () => {
    try {
      return await page.evaluate(async () => (await caches.keys()).includes("moth-shell-e2e-update"));
    } catch {
      // WebKit can destroy the evaluation context while the controllerchange
      // reload is still committing. The next poll observes the new document.
      return false;
    }
  }).toBe(true);
  await expect(page.getByText("A new Moth version is ready.", { exact: true })).toHaveCount(0);
});
