import { test, expect, login, waitForScan } from "./fixtures";
import { contentPoint, syntheticGesture, textLocation } from "./gestures";
import { makeEpubComic } from "./epubComic";

// Network failure injection must reach Playwright in WebKit as well.
// Service Worker behavior has its own coverage in core.spec.ts.
test.use({ serviceWorkers: "block" });

type HomePublication = { id: number; title: string; source_format: string; reader_format: string };

async function homePublications(page: Parameters<typeof login>[0], url: string): Promise<HomePublication[]> {
  const home = await (await page.request.get(`${url}/api/v1/home`)).json() as { directories: Array<{ series: Array<{ representative: HomePublication | null }> }> };
  return home.directories.flatMap((directory) => directory.series.flatMap((series) => series.representative ? [series.representative] : []));
}

test("mobile text reader uses compact chrome and a collapsible chapter drawer", async ({ page, app }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  await expect(page.locator(".series-cover").first()).toBeVisible();
  const coverWidths = await page.locator(".series-cover").evaluateAll((covers) => covers.map((cover) => cover.getBoundingClientRect().width));
  expect(Math.max(...coverWidths)).toBeLessThanOrEqual(120);
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
  const buttonHeights = await page.locator(".reader-titlebar .reader-control-button").evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().height)));
  expect([...new Set(buttonHeights)]).toHaveLength(1);
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

test("mobile CBZ tap, swipe, jump, retry, RTL spreads and restore load actual images", async ({ page, app, browserName }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  const cbz = (await homePublications(page, app.url)).find((book) => book.source_format === "cbz")!;
  await page.goto(`${app.url}/reader/${cbz.id}`);
  const loaded = async (index: number) => {
    const img = page.locator(`.comic-page[data-page="${index}"] img`);
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  };
  await loaded(0);
  const left = await contentPoint(page, 0.1), right = await contentPoint(page, 0.9), middle = await contentPoint(page, 0.5);
  for (let index = 1; index <= 4; index++) {
    await page.touchscreen.tap(right.x, right.y);
    await loaded(index);
  }
  await page.touchscreen.tap(left.x, left.y); await loaded(3);
  await page.touchscreen.tap(middle.x, middle.y); await loaded(3);
  await syntheticGesture(page, [right, { x: right.x - 5, y: right.y + 110 }]); await loaded(3);
  await syntheticGesture(page, [right], { cancel: true }); await loaded(3);
  await syntheticGesture(page, [right], { multi: true }); await loaded(3);
  await syntheticGesture(page, [right, { x: right.x - 110, y: right.y }]); await loaded(4);
  if (browserName === "chromium") {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [right] });
    for (let step = 1; step <= 4; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: right.x - step * 35, y: right.y }] });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await loaded(5);
    await session.detach();
  }
  await page.getByRole("button", { name: "打开页码", exact: true }).click();
  await page.locator(".reader-navigation-item").filter({ hasText: "第 7 页" }).click();
  await loaded(6);
  let failed = false;
  await page.route(`**/api/v1/publications/${cbz.id}/pages/7`, async (route) => {
    failed = true;
    await route.fulfill({ status: 500, body: "temporary failure" });
  });
  await page.touchscreen.tap(right.x, right.y);
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  expect(failed).toBe(true);
  await page.unroute(`**/api/v1/publications/${cbz.id}/pages/7`);
  await page.getByRole("button", { name: "重试", exact: true }).tap();
  await loaded(7);
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.getByLabel("漫画模式", { exact: true }).selectOption("double");
  await page.getByLabel("阅读方向", { exact: true }).selectOption("rtl");
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await loaded(7);
  await page.touchscreen.tap(right.x, right.y); await loaded(5); await loaded(6);
  const spread = await page.locator(".comic-page").evaluateAll((nodes) => nodes.map((node) => ({ page: node.getAttribute("data-page"), x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y })));
  expect(spread[0].page).toBe("5");
  expect(spread[0].x).toBeGreaterThan(spread[1].x);
  expect(Math.abs(spread[0].y - spread[1].y)).toBeLessThan(2);
  await page.touchscreen.tap(left.x, left.y); await loaded(7);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(async () => (await (await page.request.get(`${app.url}/api/v1/publications/${cbz.id}/progress`)).json()).position.page_index).toBe(7);
  await page.reload(); await loaded(7);
});

test("text tap zones stay aligned after multiple pages in the same chapter", async ({ page, app, browserName }) => {
  await login(page, app.url);
  await waitForScan(page, app.url);
  const txt = (await homePublications(page, app.url)).find((book) => book.source_format === "txt")!;
  await page.goto(`${app.url}/reader/${txt.id}`);
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await expect.poll(async () => (await textLocation(page)).cfi).toMatch(/^epubcfi/);
  const initial = await textLocation(page);
  const right = await contentPoint(page, 0.85), left = await contentPoint(page, 0.15), middle = await contentPoint(page, 0.5);
  for (let index = 0; index < 5; index++) {
    const before = await textLocation(page);
    if (index % 2) await page.mouse.click(right.x, right.y);
    else await page.touchscreen.tap(right.x, right.y);
    await expect.poll(async () => (await textLocation(page)).cfi).not.toBe(before.cfi);
    expect((await textLocation(page)).chapter).toBe(initial.chapter);
    // A mouse event immediately after touch is intentionally suppressed.
    await page.waitForTimeout(850);
  }
  const forward = await textLocation(page);
  await page.touchscreen.tap(left.x, left.y);
  await expect.poll(async () => (await textLocation(page)).cfi).not.toBe(forward.cfi);
  const stable = await textLocation(page);
  await page.touchscreen.tap(middle.x, middle.y);
  await syntheticGesture(page, [right, { x: right.x - 3, y: right.y + 100 }], { text: true });
  await syntheticGesture(page, [right], { text: true, cancel: true });
  await syntheticGesture(page, [right], { text: true, multi: true });
  await page.waitForTimeout(300);
  expect(await textLocation(page)).toEqual(stable);
  if (browserName === "chromium") {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [right] });
    for (let step = 1; step <= 6; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: right.x - step * 35, y: right.y }] });
      await page.waitForTimeout(20);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await textLocation(page)).cfi).not.toBe(stable.cfi);
    await session.detach();
  }
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.getByLabel("阅读模式", { exact: true }).selectOption("scrolled");
  await page.getByRole("button", { name: "阅读设置", exact: true }).click();
  await page.waitForTimeout(300);
  const scrolled = await textLocation(page);
  await page.touchscreen.tap(right.x, right.y);
  await page.waitForTimeout(200);
  expect(await textLocation(page)).toEqual(scrolled);
});

test("fullscreen manifest and asymmetric safe areas fit portrait and landscape", async ({ page, app }) => {
  const manifest = await (await page.request.get(`${app.url}/manifest.webmanifest`)).json();
  expect(manifest).toMatchObject({ display: "fullscreen", start_url: "/", scope: "/", orientation: "any" });
  const insets = { top: 44, right: 28, bottom: 34, left: 64 };
  const injectInsets = () => page.evaluate((insets) => {
    // Browser emulation does not provide real cutouts. Substitute asymmetric
    // insets into the built CSS to verify the physical sides, including RTL.
    const css = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n");
    const style = document.createElement("style");
    style.textContent = css.replace(/env\(safe-area-inset-(top|right|bottom|left)\)/g, (_, side: keyof typeof insets) => `${insets[side]}px`);
    document.head.append(style);
  }, insets);
  const checkPadding = async (selector: string) => {
    const padding = await page.locator(selector).evaluate((node) => {
      const css = getComputedStyle(node);
      return { left: parseFloat(css.paddingLeft), right: parseFloat(css.paddingRight), top: parseFloat(css.paddingTop), bottom: parseFloat(css.paddingBottom) };
    });
    for (const side of ["left", "right", "top", "bottom"] as const) expect(padding[side]).toBeGreaterThanOrEqual(insets[side]);
  };
  await page.goto(app.url);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
  await injectInsets(); await checkPadding(".auth-shell");
  await login(page, app.url); await waitForScan(page, app.url);
  await injectInsets(); await checkPadding(".home-shell");
  const cbz = (await homePublications(page, app.url)).find((book) => book.source_format === "cbz")!;
  await page.goto(`${app.url}/reader/${cbz.id}`);
  await expect(page.locator(".comic-page img")).toBeVisible();
  await injectInsets();
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    const metrics = await page.evaluate(() => {
      const content = document.querySelector(".reader-content")!;
      const css = getComputedStyle(content);
      const button = document.querySelector(".reader-titlebar button")!.getBoundingClientRect();
      const shell = document.querySelector(".reader-shell")!.getBoundingClientRect();
      return { left: parseFloat(css.paddingLeft), right: parseFloat(css.paddingRight), buttonTop: button.top, buttonLeft: button.left, shellBottom: shell.bottom, height: window.innerHeight };
    });
    expect(metrics.left).toBeGreaterThanOrEqual(insets.left);
    expect(metrics.right).toBeGreaterThanOrEqual(insets.right);
    expect(metrics.buttonTop).toBeGreaterThanOrEqual(insets.top);
    expect(metrics.buttonLeft).toBeGreaterThanOrEqual(insets.left);
    expect(metrics.shellBottom).toBeLessThanOrEqual(metrics.height + 1);
  }
});

for (const fixed of [false, true]) {
  test(`EPUB comic ${fixed ? "fixed RTL" : "reflowable"} images turn pages and reuse prefetched resources`, async ({ page, app }) => {
    const title = await makeEpubComic(app.books, fixed);
    await login(page, app.url);
    await waitForScan(page, app.url);
    await page.request.post(`${app.url}/api/v1/scan`);
    await waitForScan(page, app.url);
    const book = (await homePublications(page, app.url)).find((entry) => entry.title === title)!;
    expect(book).toBeTruthy();
    await page.goto(`${app.url}/reader/${book.id}`);
    await expect(page.locator(".reader-loading")).toHaveCount(0);
    await expect(page.locator(".reader-error")).toHaveCount(0);
    await expect.poll(async () => (await textLocation(page)).chapter).toBe(0);
    const artworkPoint = async (forward: boolean) => {
      const point = await contentPoint(page, (forward !== fixed) ? 0.85 : 0.15);
      // Verify native touch coordinates hit the artwork inside the scaled iframe.
      const hit = await page.locator("foliate-view").evaluate((element, point) => {
        const view = element as HTMLElement & { renderer: { getContents(): Array<{ doc: Document }> } };
        return view.renderer.getContents().some(({ doc }) => {
          const frame = doc.defaultView?.frameElement as HTMLIFrameElement;
          const rect = frame.getBoundingClientRect();
          const localX = (point.x - rect.left) * frame.offsetWidth / rect.width;
          const localY = (point.y - rect.top) * frame.offsetHeight / rect.height;
          return !!doc.elementFromPoint(localX, localY)?.closest("img,svg,image");
        });
      }, point);
      expect(hit).toBe(true);
      return point;
    };
    for (let index = 1; index <= 3; index++) {
      await page.waitForLoadState("networkidle");
      const point = await artworkPoint(true);
      await page.touchscreen.tap(point.x, point.y);
      await expect.poll(async () => (await textLocation(page)).chapter).toBe(index);
    }
    await page.waitForLoadState("networkidle");
    // Once prepared, the next and previous page must work with archive reads
    // blocked; this catches both missing prefetch and premature URL revocation.
    await page.route(`**/api/v1/publications/${book.id}/file`, (route) => route.abort());
    const forward = await artworkPoint(true);
    await page.touchscreen.tap(forward.x, forward.y);
    await expect.poll(async () => (await textLocation(page)).chapter).toBe(4);
    await page.waitForTimeout(150); // paginator releases its turn lock after relocation
    const back = await artworkPoint(false);
    await page.touchscreen.tap(back.x, back.y);
    await expect.poll(async () => (await textLocation(page)).chapter).toBe(3);
    await expect(page.locator(".reader-error")).toHaveCount(0);
    const ready = await page.locator("foliate-view").evaluate(async (element) => {
      const view = element as HTMLElement & { renderer: { getContents(): Array<{ doc: Document }> } };
      const doc = view.renderer.getContents()[0].doc;
      const source = doc.querySelector("image")?.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? doc.querySelector("img")?.src;
      const img = new Image(); img.src = source!;
      await img.decode();
      return img.naturalWidth;
    });
    expect(ready).toBe(600);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect.poll(async () => (await (await page.request.get(`${app.url}/api/v1/publications/${book.id}/progress`)).json()).position.cfi).toBe((await textLocation(page)).cfi);
    await page.unroute(`**/api/v1/publications/${book.id}/file`);
    await page.reload();
    await expect.poll(async () => (await textLocation(page)).chapter).toBe(3);
  });
}
