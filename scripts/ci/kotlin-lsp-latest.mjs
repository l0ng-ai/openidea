#!/usr/bin/env node
// The newest published kotlin-lsp build, from the same place the IDE reads it (crates/ide-tools:
// the Kotlin/kotlin-lsp GitHub releases, whose notes link the archives on download.jetbrains.com).
// Prints the version; with --json also each platform's archive URL and the sha256 JetBrains publishes.
import { pathToFileURL } from "node:url";

const REPO = "Kotlin/kotlin-lsp";
const HOST = "https://download.jetbrains.com/language-server/kotlin-server";
const ARCHIVES = { linux: (v) => `kotlin-server-${v}.tar.gz`, windows: (v) => `kotlin-server-${v}.win.zip` };

async function get(url, token) {
  const headers = {
    "user-agent": "openidea-ci",
    ...(token && url.startsWith("https://api.github.com/") ? { authorization: `Bearer ${token}` } : {}),
  };
  let status;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers }).catch(() => null);
    if (res?.ok) return res;
    status = res?.status;
    if (res && res.status < 500 && res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`${url}: ${status ? `HTTP ${status}` : "network error"}`);
}

export async function latestKotlinLsp(token = process.env.GITHUB_TOKEN) {
  const releases = await (await get(`https://api.github.com/repos/${REPO}/releases?per_page=30`, token)).json();
  for (const release of releases) {
    const version = /^kotlin-lsp\/v(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1];
    if (!version || release.draft || release.prerelease) continue;
    // Old releases (0.x) link kotlin-lsp-* archives; only kotlin-server-* ones have the archives the IDE installs.
    if (!Object.values(ARCHIVES).every((name) => (release.body ?? "").includes(name(version)))) continue;
    const out = { version, tag: release.tag_name, publishedAt: release.published_at };
    for (const [os, name] of Object.entries(ARCHIVES)) {
      const url = `${HOST}/${version}/${name(version)}`;
      const sha = /^([0-9a-f]{64})/i.exec(await (await get(`${url}.sha256`)).text())?.[1];
      if (!sha) throw new Error(`no sha256 published for ${url}`);
      out[os] = { url, sha256: sha.toLowerCase() };
    }
    return out;
  }
  throw new Error(`no kotlin-server release found in the latest 30 ${REPO} releases`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const latest = await latestKotlinLsp();
  console.log(process.argv.includes("--json") ? JSON.stringify(latest, null, 2) : latest.version);
}
