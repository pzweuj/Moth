import { test, expect, login, waitForScan } from "./fixtures";

test("home, directory browsing and service-worker shell", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  await expect(page.getByRole("heading", { name: "继续阅读", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "目录", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "英文", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /The Fixture Novel/ })).toBeVisible();
  await page.getByRole("link", { name: /The Fixture Novel/ }).click();
  await expect(page.getByRole("heading", { name: "The Fixture Novel", exact: true })).toBeVisible();
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
  await expect(page.locator(".reader-encoding select")).toBeVisible();
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeVisible();
  await expect.poll(async () => {
    const progress = await page.request.get(`${app.url}/api/v1/publications/${txt!.id}/progress`);
    return (await progress.json())?.position?.type ?? "";
  }).toBe("txt");
  await page.goto(`${app.url}/reader/${cbz!.id}`);
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await expect(page.locator(".reader-tools select").first()).toBeVisible();
  await page.locator(".reader-tools select").first().selectOption("double");
  await page.locator(".reader-tools select").first().selectOption("webtoon");
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
