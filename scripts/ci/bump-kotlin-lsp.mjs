#!/usr/bin/env node
// Moves KOTLIN_LSP and its archive checksums in .github/tool-versions.env to the newest published
// build (JetBrains builds expire after a few weeks). Downloads each archive and hashes it, and
// refuses to write when that differs from the sha256 JetBrains publishes. Prints the new version
// (and sets `version` / `changed` outputs for GitHub Actions); changes nothing when already current.
// Usage: bump-kotlin-lsp.mjs [--file <tool-versions.env>]
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { latestKotlinLsp } from "./kotlin-lsp-latest.mjs";

const args = process.argv.slice(2);
const fileArg = args.indexOf("--file");
const file =
  fileArg >= 0
    ? args[fileArg + 1]
    : join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "tool-versions.env");

async function sha256Of(url) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const hash = createHash("sha256");
  for await (const chunk of res.body) hash.update(chunk);
  return hash.digest("hex");
}

function setKey(text, key, value) {
  const re = new RegExp(`^${key}=.*?(\\r?)$`, "m");
  if (!re.test(text)) throw new Error(`${key} is missing from ${file}`);
  return text.replace(re, (_, cr) => `${key}=${value}${cr}`);
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

let text = readFileSync(file, "utf8");
const current = /^KOTLIN_LSP=(\S+)/m.exec(text)?.[1];
const latest = await latestKotlinLsp();
output("version", latest.version);
if (current === latest.version) {
  console.log(`KOTLIN_LSP ${current} is already the newest build`);
  output("changed", "false");
  process.exit(0);
}

const sums = {};
for (const os of ["linux", "windows"]) {
  sums[os] = await sha256Of(latest[os].url);
  if (sums[os] !== latest[os].sha256) {
    throw new Error(`${latest[os].url}: downloaded sha256 ${sums[os]} differs from the published ${latest[os].sha256}`);
  }
  console.log(`${os}: ${sums[os]}`);
}

text = setKey(text, "KOTLIN_LSP", latest.version);
text = setKey(text, "KOTLIN_LSP_SHA256_LINUX", sums.linux);
text = setKey(text, "KOTLIN_LSP_SHA256_WINDOWS", sums.windows);
writeFileSync(file, text);
console.log(`KOTLIN_LSP ${current} -> ${latest.version}`);
output("changed", "true");
