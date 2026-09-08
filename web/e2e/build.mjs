import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function build() {
  if (process.env.MOTH_E2E_SKIP_BUILD === "1") return;
  const web = fileURLToPath(new URL("..", import.meta.url));
  const root = fileURLToPath(new URL("../..", import.meta.url));
  execFileSync("cargo", ["build", "-p", "moth-server", "--bin", "moth-server", "--example", "make_books"], { cwd: root, stdio: "inherit" });
  for (const script of ["node_modules/typescript/bin/tsc", "node_modules/vite/bin/vite.js", "scripts/precache.mjs"]) {
    const args = script.includes("typescript") ? ["-b"] : script.includes("vite/") ? ["build"] : [];
    execFileSync(process.execPath, [script, ...args], { cwd: web, stdio: "inherit" });
  }
}
