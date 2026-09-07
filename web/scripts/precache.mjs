/* global URL */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(webDir, "dist");
const assetsDir = join(distDir, "assets");
const swPath = join(distDir, "sw.js");
const assets = (await readdir(assetsDir)).sort().map((file) => `  "/assets/${file}",`);
const source = await readFile(swPath, "utf8");
const index = await readFile(join(distDir, "index.html"));
const marker = "  /* __MOTH_PRECACHE_ASSETS__ */";
if (!source.includes(marker)) throw new Error("Service worker precache marker is missing");
const version = createHash("sha256")
  .update(source)
  .update(index)
  .update(assets.join("\n"))
  .digest("hex")
  .slice(0, 12);
const versionMarker = "__MOTH_BUILD_VERSION__";
if (!source.includes(versionMarker)) throw new Error("Service worker version marker is missing");
await writeFile(
  swPath,
  source
    .replace(versionMarker, version)
    .replace(marker, assets.join("\n")),
  "utf8",
);
