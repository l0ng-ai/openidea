/**
 * Writes the Homebrew cask for a published release:
 * `node scripts/homebrew-cask.ts <tag> <dir> <out>`. `<dir>` holds the release's macOS DMGs
 * (`gh release download <tag> -p '*.dmg'`); `<out>` is the cask file to write, e.g.
 * `Casks/openidea.rb` in a checkout of the tap (l0ng-ai/homebrew-tap). The cask lets the app
 * update itself (`auto_updates true`): the Tauri updater and `brew upgrade` don't fight.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_REPO = "l0ng-ai/openidea";
const IDENTIFIER = "ai.l0ng.openidea";

/** The DMG of each Homebrew arch, as the release names it. */
export const DMG_ARCH = { arm: "aarch64", intel: "x64" } as const;

export interface Checksums {
  arm: string;
  intel: string;
}

/** The version of a stable release tag (`v0.1.51` → `0.1.51`); prereleases have none. */
export function stableVersion(tag: string): string | null {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  return match ? match[1]! : null;
}

export function dmgName(version: string, arch: keyof typeof DMG_ARCH): string {
  return `OpenIDEA_${version}_${DMG_ARCH[arch]}.dmg`;
}

export function renderCask(version: string, sha256: Checksums): string {
  for (const [arch, sum] of Object.entries(sha256)) {
    if (!/^[0-9a-f]{64}$/.test(sum)) throw new Error(`${arch}: ${sum} is not a SHA-256`);
  }
  return `cask "openidea" do
  arch arm: "${DMG_ARCH.arm}", intel: "${DMG_ARCH.intel}"

  version "${version}"
  sha256 arm:   "${sha256.arm}",
         intel: "${sha256.intel}"

  url "https://github.com/${GITHUB_REPO}/releases/download/v#{version}/OpenIDEA_#{version}_#{arch}.dmg"
  name "OpenIDEA"
  desc "IDE inspired by IntelliJ IDEA, rebuilt in Rust"
  homepage "https://openidea.sh/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on :macos

  app "OpenIDEA.app"
  binary "#{appdir}/OpenIDEA.app/Contents/Resources/bin/openidea"

  zap trash: [
    "~/Library/Application Support/${IDENTIFIER}",
    "~/Library/Caches/${IDENTIFIER}",
    "~/Library/HTTPStorages/${IDENTIFIER}",
    "~/Library/Logs/${IDENTIFIER}",
    "~/Library/Preferences/${IDENTIFIER}.plist",
    "~/Library/Saved Application State/${IDENTIFIER}.savedState",
    "~/Library/WebKit/${IDENTIFIER}",
  ]
end
`;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function main() {
  const [tag, dir, out] = process.argv.slice(2);
  if (!tag || !dir || !out) throw new Error("usage: node scripts/homebrew-cask.ts <tag> <dir> <out>");
  const version = stableVersion(tag);
  if (!version) throw new Error(`${tag} is not a stable release tag`);
  const sum = async (arch: keyof typeof DMG_ARCH) => {
    const path = join(dir, dmgName(version, arch));
    if (!existsSync(path)) throw new Error(`${path} is missing`);
    return sha256File(path);
  };
  const cask = renderCask(version, { arm: await sum("arm"), intel: await sum("intel") });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, cask);
  console.log(`wrote ${out} for OpenIDEA ${version}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
