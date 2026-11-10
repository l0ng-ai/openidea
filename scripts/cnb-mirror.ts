/**
 * Mirrors a published release to CNB (cnb.cool/l0ng-ai/openidea), where the updater's
 * CNB source reads `releases/latest/download/latest.json`:
 * `node scripts/cnb-mirror.ts <tag> <dir>` with `CNB_TOKEN` set (scopes `repo-code:r`,
 * `repo-release:rw`). `<dir>` holds the release's assets (`gh release download`) and
 * `release.json` (`gh release view --json body,isPrerelease`). Every asset is uploaded,
 * `latest.json` last and pointing at CNB, so the mirror's manifest never names a bundle it
 * lacks. Only the newest `KEEP` releases stay on CNB. Safe to rerun: uploads overwrite.
 */
import { openAsBlob, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CNB_REPO = "l0ng-ai/openidea";
const GITHUB_REPO = "l0ng-ai/openidea";
const API = `https://api.cnb.cool/${CNB_REPO}`;
export const KEEP = 10;
const PARALLEL = 4;
const MANIFEST = "latest.json";
const RELEASE_INFO = "release.json";

interface Manifest {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, { signature: string; url: string }>;
}

interface CnbRelease {
  id: string;
  tag_name: string;
  created_at: string;
}

/** `manifest` with each bundle URL moved from the GitHub release to the CNB one. */
export function mirrorManifest(manifest: Manifest, tag: string): Manifest {
  const from = `https://github.com/${GITHUB_REPO}/releases/download/${tag}/`;
  const to = `https://cnb.cool/${CNB_REPO}/-/releases/download/${tag}/`;
  const platforms: Manifest["platforms"] = {};
  for (const [key, entry] of Object.entries(manifest.platforms)) {
    if (!entry.url.startsWith(from)) throw new Error(`${key}: ${entry.url} is not an asset of ${tag}`);
    platforms[key] = { ...entry, url: to + entry.url.slice(from.length) };
  }
  return { ...manifest, platforms };
}

/** Releases beyond the newest `keep` (by creation time), never `current`. */
export function releasesToPrune(releases: CnbRelease[], current: string, keep = KEEP): CnbRelease[] {
  const newest = [...releases].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return newest.slice(keep).filter((r) => r.tag_name !== current);
}

function token(): string {
  const value = process.env.CNB_TOKEN?.trim();
  if (!value) throw new Error("CNB_TOKEN is not set");
  return value;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const res = await fetch(path.startsWith("https://") ? path : API + path, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      accept: "application/vnd.cnb.api+json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404 && method === "GET") return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text}`);
  return text ? (JSON.parse(text) as T) : null;
}

async function withRetry<T>(what: string, run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= attempts) throw e;
      console.warn(`${what}: ${e instanceof Error ? e.message : e}; retrying (${i}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

async function ensureRelease(tag: string, body: string, prerelease: boolean): Promise<string> {
  const existing = await api<CnbRelease>("GET", `/-/releases/tags/${encodeURIComponent(tag)}`);
  if (existing) return existing.id;
  const created = await api<CnbRelease>("POST", "/-/releases", {
    tag_name: tag,
    target_commitish: "main",
    name: tag,
    body,
    prerelease,
    make_latest: prerelease ? "false" : "true",
  });
  return created!.id;
}

async function upload(releaseId: string, name: string, file: Blob) {
  const target = await api<{ upload_url: string; verify_url: string }>(
    "POST",
    `/-/releases/${releaseId}/asset-upload-url`,
    { asset_name: name, size: file.size, overwrite: true },
  );
  const put = await fetch(target!.upload_url, { method: "PUT", body: file });
  if (!put.ok) throw new Error(`PUT ${name}: HTTP ${put.status} ${await put.text()}`);
  await api("POST", target!.verify_url);
}

async function uploadAll(releaseId: string, dir: string, names: string[]) {
  const queue = [...names];
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const path = join(dir, name);
      const mb = (statSync(path).size / 1048576).toFixed(1);
      const started = Date.now();
      await withRetry(name, async () => upload(releaseId, name, await openAsBlob(path)));
      console.log(`uploaded ${name} (${mb} MB, ${Math.round((Date.now() - started) / 1000)} s)`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
}

async function prune(current: string) {
  const releases = (await api<CnbRelease[]>("GET", "/-/releases?page_size=100")) ?? [];
  for (const old of releasesToPrune(releases, current)) {
    await api("DELETE", `/-/releases/${old.id}`);
    await api("DELETE", `/-/git/tags/${encodeURIComponent(old.tag_name)}`).catch((e) => console.warn(String(e)));
    console.log(`removed ${old.tag_name}`);
  }
}

async function main() {
  const [tag, dir] = process.argv.slice(2);
  if (!tag || !dir) throw new Error("usage: node scripts/cnb-mirror.ts <tag> <dir>");
  const info = JSON.parse(readFileSync(join(dir, RELEASE_INFO), "utf8")) as { body?: string; isPrerelease?: boolean };
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Manifest;
  const mirrored = mirrorManifest(manifest, tag);
  const assets = readdirSync(dir).filter(
    (n) => n !== MANIFEST && n !== RELEASE_INFO && statSync(join(dir, n)).isFile(),
  );

  const releaseId = await ensureRelease(tag, info.body ?? "", !!info.isPrerelease);
  console.log(`CNB release ${tag} (${releaseId}): uploading ${assets.length} assets`);
  await uploadAll(releaseId, dir, assets);
  const blob = new Blob([JSON.stringify(mirrored, null, 2)], { type: "application/json" });
  await withRetry(MANIFEST, () => upload(releaseId, MANIFEST, blob));
  console.log(`uploaded ${MANIFEST}: ${Object.keys(mirrored.platforms).length} platforms`);
  await prune(tag);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
