import { test as base, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, cp, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const suffix = process.platform === "win32" ? ".exe" : "";
// Keep the fixture in lockstep with the Cargo target used by globalSetup.
// This lets local runs use an isolated target directory when another process
// holds the repository's default Cargo build lock.
const cargoTarget = process.env.CARGO_TARGET_DIR
  ? resolve(root, process.env.CARGO_TARGET_DIR)
  : resolve(root, "target");
const binary = resolve(cargoTarget, `debug/moth-server${suffix}`);
export const credentials = { username: "reader", password: "moth-e2e-password" };
export const test = base.extend<{ app: { url: string; books: string; web: string } }>({
  // Playwright requires destructuring even when the fixture has no dependencies.
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, provide, info) => {
    const directory = info.outputPath("app");
    const books = resolve(directory, "books");
    const web = resolve(directory, "web");
    await mkdir(books, { recursive: true });
    await cp(resolve(root, "web/dist"), web, { recursive: true });
    execFileSync(resolve(cargoTarget, `debug/examples/make_books${suffix}`), [books], { windowsHide: true });
    await cp(resolve(root, "crates/moth-format/tests/fixtures/alice.mobi"), resolve(books, "alice.mobi"));
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((done) => listener.close(() => done()));
    const url = `http://127.0.0.1:${port}`;
    const logPath = info.outputPath("server.log");
    const log = createWriteStream(logPath);
    const server = spawn(binary, [], {
      cwd: root, windowsHide: true,
      env: { ...process.env, MOTH_BIND_ADDR: `127.0.0.1:${port}`, MOTH_DATA_DIR: resolve(directory, "data"), MOTH_BOOKS_DIR: books, MOTH_WEB_DIR: web },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.pipe(log);
    server.stderr.pipe(log);
    let spawnError: Error | undefined;
    server.on("error", (error) => { spawnError = error; });
    try {
      await expect.poll(async () => {
        if (spawnError) throw spawnError;
        return fetch(`${url}/api/v1/health`).then((r) => r.status).catch(() => 0);
      }).toBe(200);
      await provide({ url, books, web });
    } finally {
      if (server.exitCode === null) {
        const exited = new Promise<void>((done) => server.once("exit", () => done()));
        server.kill();
        await exited;
      }
      await new Promise<void>((done) => log.end(done));
      await info.attach("server.log", { body: await readFile(logPath), contentType: "text/plain" });
    }
  },
});
export { expect };

export async function login(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill(credentials.username);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByLabel("Repeat password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Set up your account", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect.poll(async () => {
    const result = await page.request.get(`${url}/api/v1/books`);
    return (await result.json()).length;
  }).toBeGreaterThanOrEqual(6);
  await page.goto(`${url}/all`);
}

export async function openBook(page: Page, title: string) {
  await page.getByRole("link", { name: `Read ${title}`, exact: true }).click();
  await expect(page.locator(".reader-title")).toHaveText(title);
  await expect(page.locator(".reader-loading")).toHaveCount(0);
  await expect(page.locator(".reader-error")).toHaveCount(0);
  await expect(page.locator(".reader-position")).toBeVisible();
}

/**
 * Reload through the page itself while offline. WebKit on Windows reports an
 * internal navigation error when Playwright waits for an offline reload;
 * scheduling location.reload() lets the Service Worker perform the same
 * browser refresh without hiding the subsequent reader assertions.
 */
export async function reloadOffline(page: Page) {
  if (page.context().browser()?.browserType().name() !== "webkit") {
    await page.reload();
    return;
  }
  await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
  await page.waitForTimeout(750);
}

export async function rendered(page: Page) {
  return page.locator("foliate-view").evaluate((view) => {
    const doc = (view as HTMLElement & { renderer?: { getContents(): { doc: Document }[] } }).renderer?.getContents()[0]?.doc;
    const image = doc?.querySelector<HTMLImageElement>('img[alt="cover"]');
    return {
      heading: doc?.querySelector("h1")?.textContent,
      active: doc?.querySelectorAll("script, [onerror]").length,
      imageReady: !!image?.complete && image.naturalWidth > 0,
      text: doc?.body?.textContent,
    };
  });
}

// Read the actual persistent stores, including after offline reload. Do not
// replace browser IndexedDB with mocks in the end-to-end suite.
export async function records(page: Page, store: string) {
  return page.evaluate(async (storeName) => {
    const scope = JSON.parse(localStorage.getItem("moth:offline-scope")!);
    const identity = [location.origin, scope.instanceId || "unknown-instance", scope.accountId || scope.username || "anonymous"].join("|");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(`moth-reader-v3-${encodeURIComponent(identity)}`);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const request = db.transaction(storeName).objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }, store);
}
