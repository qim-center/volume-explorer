#!/usr/bin/env node
// Fails the build if the bundled app references an external host (CDN)
import { readdirSync, readFileSync } from "node:fs";

const appDir = new URL("../dist/app/", import.meta.url).pathname;

const externalAsset =
  /(?:<(?:link|script|img|source|iframe)\b[^>]*\b(?:href|src)\s*=\s*["']?|url\(\s*["']?|@import\s+["'])((?:https?:)?\/\/[^"'\s)>]+)/gi;

const problems = readdirSync(appDir, { recursive: true })
  .filter((file) => /\.(html|css)$/.test(file))
  .flatMap((file) =>
    [...readFileSync(appDir + file, "utf8").matchAll(externalAsset)].map((match) => `  ${file}: ${match[1]}`),
  );

if (problems.length > 0) {
  console.error(`External assets found in dist/app (bundle them locally instead):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("No external assets referenced in dist/app.");
