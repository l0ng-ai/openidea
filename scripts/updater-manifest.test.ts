// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/release-build.yml", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const job = workflow.split("\n  updater-manifest:")[1]!;
const script = job.split("          script: |\n")[1]!.replace(/^ {12}/gm, "");
const run = new Function("github", "context", "core", `return (async () => {${script}\n})();`);

afterEach(() => vi.unstubAllEnvs());

it.each(["v0.1.42", "v0.1.43-nightly.20261112"])(
  "publishes signed portable updates for both Windows architectures alongside the installers (%s)",
  async (tag) => {
    vi.stubEnv("TAG", tag);
    vi.stubEnv("RELEASE_ID", "42");
    const version = tag.slice(1);
    const nightly = tag.includes("-nightly.");
    const bundles = [
      "OpenIDEA_aarch64.AppImage",
      "OpenIDEA_arm64.deb",
      "OpenIDEA.aarch64.rpm",
      "OpenIDEA_amd64.AppImage",
      "OpenIDEA_amd64.deb",
      "OpenIDEA.x86_64.rpm",
      "OpenIDEA_aarch64.app.tar.gz",
      "OpenIDEA_x64.app.tar.gz",
      "OpenIDEA_arm64_en-US.msi",
      "OpenIDEA_arm64-setup.exe",
      "OpenIDEA_x64_en-US.msi",
      "OpenIDEA_x64-setup.exe",
      `OpenIDEA_${version}_windows_x64_portable.zip`,
      `OpenIDEA_${version}_windows_arm64_portable.zip`,
    ].filter((name) => !nightly || (!name.endsWith(".msi") && !name.endsWith(".rpm")));
    const assets = bundles.flatMap((name, id) => [
      { name, id: id * 2 },
      { name: `${name}.sig`, id: id * 2 + 1 },
    ]);
    const upload = vi.fn();
    const failed = vi.fn();
    await run(
      {
        paginate: async () => assets,
        rest: {
          repos: {
            listReleaseAssets: vi.fn(),
            getRelease: async () => ({ data: { body: "Release notes" } }),
            getReleaseAsset: async ({ asset_id }: { asset_id: number }) => ({
              data: Buffer.from(`signature-${asset_id}\n`),
            }),
            uploadReleaseAsset: upload,
          },
        },
      },
      { repo: { owner: "l0ng-ai", repo: "openidea" } },
      { notice: vi.fn(), info: vi.fn(), setFailed: failed },
    );
    expect(failed).not.toHaveBeenCalled();
    const manifest = JSON.parse(upload.mock.calls[0]![0].data);
    for (const [arch, filename] of [
      ["x86_64", "x64"],
      ["aarch64", "arm64"],
    ]) {
      const name = `OpenIDEA_${version}_windows_${filename}_portable.zip`;
      const sig = assets.find((a) => a.name === `${name}.sig`)!;
      expect(manifest.platforms[`windows-${arch}-portable`]).toEqual({
        signature: `signature-${sig.id}`,
        url: `https://github.com/l0ng-ai/openidea/releases/download/${tag}/${name}`,
      });
      expect(manifest.platforms[`windows-${arch}`].url).toContain(nightly ? "-setup.exe" : "_en-US.msi");
      expect(manifest.platforms[`windows-${arch}-nsis`].url).toContain("-setup.exe");
    }
  },
);
