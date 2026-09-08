import { test as base, expect, type Page } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, cp, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const suffix = process.platform === "win32" ? ".exe" : "";
const cargoTarget = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : resolve(root, "target");
const binary = resolve(cargoTarget, `debug/moth-server${suffix}`);
export const credentials = { username: "reader", password: "moth-e2e-password" };

export const test = base.extend<{ app: { url: string; books: string; web: string } }>({
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
    const server = spawn(binary, [], { cwd: root, windowsHide: true, env: { ...process.env, MOTH_BIND_ADDR: `127.0.0.1:${port}`, MOTH_DATA_DIR: resolve(directory, "data"), MOTH_BOOKS_DIR: books, MOTH_WEB_DIR: web }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.pipe(log);
    server.stderr.pipe(log);
    let spawnError: Error | undefined;
    server.on("error", (error) => { spawnError = error; });
    try {
      await expect.poll(async () => { if (spawnError) throw spawnError; return fetch(`${url}/api/v1/health`).then((response) => response.status).catch(() => 0); }).toBe(200);
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
  await page.getByLabel("用户名", { exact: true }).fill(credentials.username);
  await page.getByLabel("密码", { exact: true }).fill(credentials.password);
  await page.getByLabel("重复密码", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "创建账户", exact: true }).click();
  await expect(page.getByRole("button", { name: "退出", exact: true })).toBeVisible();
  await expect.poll(async () => {
    const response = await page.request.get(`${url}/api/v1/publications`);
    return (await response.json() as unknown[]).length;
  }).toBeGreaterThanOrEqual(5);
}

export async function waitForScan(page: Page, url: string) {
  await expect.poll(async () => {
    const response = await page.request.get(`${url}/api/v1/libraries/default/scan/status`);
    const value = await response.json();
    return value.scanning;
  }).toBe(false);
}
