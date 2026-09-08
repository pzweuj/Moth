import { test, expect, login, waitForScan } from "./fixtures";

test("home, directory browsing, search and service-worker shell", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  await expect(page.getByRole("heading", { name: "继续阅读", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "目录", exact: true })).toBeVisible();
  await page.locator(".library-card a").first().click();
  await expect(page.getByText("目录 / default", { exact: true })).toBeVisible();
  await page.getByPlaceholder("搜索标题、作者或文件名").fill("Fixture");
  await expect(page.getByText("The Fixture Novel", { exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const caches = await page.evaluate(() => caches.keys());
  expect(caches.every((name) => name.startsWith("moth-shell-"))).toBe(true);
  expect(await page.evaluate(async () => (await caches.match("/api/v1/home")) !== undefined)).toBe(false);
});

test("TXT and CBZ readers use the online publication API", async ({ page, app }) => {
  await login(page, app.url);
  const publications = await (await page.request.get(`${app.url}/api/v1/publications`)).json() as Array<{ id: number; source_format: string; title: string }>;
  const txt = publications.find((publication) => publication.source_format === "txt");
  const cbz = publications.find((publication) => publication.source_format === "cbz");
  expect(txt).toBeTruthy();
  await page.goto(`${app.url}/reader/${txt!.id}`);
  await expect(page.locator(".reader-encoding select")).toBeVisible();
  await page.locator(".reader-encoding select").selectOption("gb18030");
  await expect(page.getByText("下一章", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const progress = await page.request.get(`${app.url}/api/v1/publications/${txt!.id}/progress`);
    expect(progress.ok()).toBe(true);
    return (await progress.json())?.position?.type ?? "";
  }).toBe("txt");
  await page.goto(`${app.url}/reader/${cbz!.id}`);
  await expect(page.locator(".reader-tools select").first()).toBeVisible();
  await page.locator(".reader-tools select").first().selectOption("double");
  await page.locator(".reader-tools select").first().selectOption("webtoon");
});

test("classic MOBI exposes conversion and EPUB reader format", async ({ page, app }) => {
  await login(page, app.url);
  const publications = await (await page.request.get(`${app.url}/api/v1/publications?format=mobi`)).json() as Array<{ id: number; reader_format: string }>;
  expect(publications.length).toBeGreaterThan(0);
  expect(publications[0].reader_format).toBe("epub");
  const response = await page.request.post(`${app.url}/api/v1/publications/${publications[0].id}/conversion`);
  expect([200, 202]).toContain(response.status());
});
