import { readFile, mkdir, writeFile } from "node:fs/promises";
import { buildDownloadManifest } from "../src/lib/downloads.mjs";

// A saved GitHub API response can be used for a reproducible, offline refresh.
const input = process.argv[2];
let release;
if (input) {
  release = JSON.parse(await readFile(input, "utf8"));
} else {
  const response = await fetch("https://api.github.com/repos/l0ng-ai/openidea/releases/latest", {
    headers: {
      Accept: "application/vnd.github+json",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Unable to load the latest release (${response.status})`);
  release = await response.json();
}
const manifest = buildDownloadManifest(release);
const destination = new URL("../src/data/", import.meta.url);
await mkdir(destination, { recursive: true });
await writeFile(new URL("release.json", destination), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Download manifest: ${manifest.tag}, ${Object.values(manifest.packages).flat().length} installers`);
