import { test, expect, login, openBook, records, rendered, reloadOffline } from "./fixtures";

test("real MOBI parses, navigates, caches and restores offline", async ({ page, context, app }) => {
  await login(page, app.url);
  const books = await (await page.request.get(`${app.url}/api/v1/books`)).json();
  const book = books.find((book: { format: string; parse_status: string }) => book.format === "mobi" && book.parse_status === "ok");
  expect(book?.title).toContain("Alice");
  await openBook(page, book.title);
  await expect(page.getByText("AZW3/KF8: experimental", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Contents", exact: true }).click();
  await page.getByRole("dialog", { name: "Contents", exact: true }).getByRole("button", { name: /Down the Rabbit.Hole/i }).click();
  await expect.poll(async () => (await rendered(page)).text).toContain("Rabbit");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect.poll(async () => (await records(page, "chapters")).length).toBeGreaterThan(0);
  const position = await page.locator(".reader-position").innerText();
  await context.setOffline(true);
  await reloadOffline(page);
  await expect(page.locator(".reader-position")).toHaveText(position);
  await expect.poll(async () => (await rendered(page)).text).toContain("Rabbit");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator(".save-indicator")).toHaveText("Saved on device");
  await context.setOffline(false);
  await expect.poll(async () => (await records(page, "queue")).length).toBe(0);
});

test.describe("touch viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const format of ["txt", "cbz"]) {
    test(`${format} outer tap turns a page and landscape retains controls`, async ({ page, app }) => {
      await login(page, app.url);
      await openBook(page, format === "txt" ? "第一章 夜色入海" : "晨光短篇");
      const before = await records(page, "progressByContext");
      await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeHidden();
      const host = page.locator(format === "txt" ? ".reader-host" : ".comic-viewport");
      const box = await host.boundingBox();
      expect(box).not.toBeNull();
      await page.touchscreen.tap(box!.x + box!.width * 0.85, box!.y + box!.height * 0.5);
      await expect.poll(async () => (await records(page, "progressByContext"))[0]?.localSequence).toBeGreaterThan(before[0]?.localSequence ?? 0);
      await page.setViewportSize({ width: 844, height: 390 });
      await expect(page.getByRole("button", { name: "Reader settings", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Reader settings", exact: true }).tap();
      await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    });
  }
});
