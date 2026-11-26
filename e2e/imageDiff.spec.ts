import type { Page } from "@playwright/test";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";

async function pngVersions(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 3;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "teal";
    ctx.fillRect(0, 0, 4, 3);
    const head = canvas.toDataURL();
    ctx.clearRect(2, 1, 1, 1);
    ctx.fillStyle = "rgba(0, 128, 128, 0.5)";
    ctx.fillRect(2, 1, 1, 1);
    const index = canvas.toDataURL();
    ctx.clearRect(0, 0, 2, 1);
    return { head, index, local: canvas.toDataURL() };
  });
}

async function expectCount(page: Page, count: number) {
  await expect(
    page.getByRole("status").filter({ hasText: new RegExp(`^${count} changed pixels?$`, "i") }),
  ).toBeVisible();
}

test("Commit Changes renders a PNG and highlights one alpha-only change", async ({ workbench: page }) => {
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  const { head, index: local } = await pngVersions(page);
  const file = "status.png";
  const path = ROOT + "/" + file;
  await page.evaluate(
    async ({ root, path, file, head, local }) => {
      const handlers = window.__ipc.handlers;
      const branch = { head: "main", headCommit: "1111111", operation: null, upstream: null, ahead: 0, behind: 0 };
      handlers.vcs_roots = () => [{ root, ...branch }];
      handlers.vcs_branch_info = () => branch;
      handlers.vcs_branches = () => [];
      handlers.vcs_stashes = () => [];
      handlers.vcs_status = () => [{ path, relPath: file, staged: null, unstaged: "modified", renamedFrom: null }];
      handlers.vcs_image_at = ({ rev }) => (rev === "HEAD" ? head : null);
      handlers.fs_read_image = () => local;
      const store = "/src/features/vcs/store.ts";
      const { useVcs, refreshNow } = await import(/* @vite-ignore */ store);
      useVcs.setState({ available: true, root, repo: root, branchesLoaded: false, stashesLoaded: false });
      await refreshNow();
    },
    { root: ROOT, path, file, head, local },
  );
  await page.keyboard.press("Meta+k");
  await page.getByRole("tree", { name: "Changes" }).getByText(file, { exact: true }).dblclick();
  const toolbar = page.getByRole("toolbar", { name: "Image diff" });
  const highlight = toolbar.getByRole("button", { name: "Highlight changed pixels" });
  await highlight.click();
  await expectCount(page, 1);
  const mask = page.getByLabel("Pixel difference mask");
  await expect(mask).toBeVisible();
  const pixels = await mask.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from({ length: canvas.width * canvas.height }, (_, i) => data.slice(4 * i, 4 * i + 4).join(","));
  });
  expect(pixels).toHaveLength(12);
  expect(pixels.filter((pixel) => pixel !== pixels[0])).toEqual([pixels[6]]);
  expect(pixels[6]).not.toBe(pixels[0]);
  await highlight.click();
  await expect(mask).toBeHidden();
  expect(await ipcCalls(page, "vcs_image_at")).toContainEqual({ path, rev: "HEAD" });
  expect(await ipcCalls(page, "fs_read_image")).toContainEqual({ path });
});

test("staged and unstaged PNG diffs compare the index with the specified side", async ({ workbench: page }) => {
  await stubDesktop(page);
  const images = await pngVersions(page);
  await page.evaluate(({ head, index, local }) => {
    window.__ipc.handlers.vcs_image_at = ({ rev }) => (rev === "HEAD" ? head : rev === ":0" ? index : null);
    window.__ipc.handlers.fs_read_image = () => local;
  }, images);
  for (const [side, count] of [
    ["staged", 1],
    ["unstaged", 2],
  ] as const) {
    await page.evaluate(
      async ({ side, root }) => {
        const input = "/src/features/vcs/diffInput.ts";
        const { openDiff, workingDiffData } = await import(/* @vite-ignore */ input);
        const path = root + "/status.png";
        const status = { path, relPath: "status.png", staged: "modified", unstaged: "modified", renamedFrom: null };
        await openDiff(workingDiffData(path, undefined, side, status));
      },
      { side, root: ROOT },
    );
    const highlight = page.getByRole("button", { name: "Highlight changed pixels" });
    await highlight.click();
    await expectCount(page, count);
    await highlight.click();
  }
});

test("the three-way PNG diff labels each revision and compares all three pairs", async ({ workbench: page }) => {
  await stubDesktop(page);
  const images = await pngVersions(page);
  await page.evaluate(async ({ head, index, local }) => {
    window.__ipc.handlers.vcs_image_at = ({ rev }) => (rev === "HEAD" ? head : rev === ":0" ? index : null);
    window.__ipc.handlers.fs_read_image = () => local;
    const input = "/src/features/vcs/diffInput.ts";
    const { openDiff, stagingGutterDiffData } = await import(/* @vite-ignore */ input);
    await openDiff(stagingGutterDiffData("/dev/acme-api/status.png"));
  }, images);
  for (const [label, url] of [
    ["HEAD", images.head],
    ["Staged (index)", images.index],
    ["Local Version", images.local],
  ] as const) {
    await expect(page.getByRole("img", { name: label, exact: true })).toHaveAttribute("src", url);
  }
  const toolbar = page.getByRole("toolbar", { name: "Image diff" });
  await toolbar.getByRole("button", { name: "Highlight changed pixels" }).click();
  await expectCount(page, 1);
  for (const [pair, count] of [
    ["Staged (index) ↔ Local Version", 2],
    ["HEAD ↔ Local Version", 3],
  ] as const) {
    await toolbar.getByRole("button", { name: "Compare revisions" }).click();
    await page.getByRole("option", { name: pair }).click();
    await expectCount(page, count);
  }
});

for (const ext of ["jpg", "jpeg", "webp", "svg"] as const) {
  test(`renders both historical revisions of a renamed .${ext} without a working file`, async ({ workbench: page }) => {
    await stubDesktop(page);
    const path = `${ROOT}/current.${ext}`;
    const oldPath = `${ROOT}/original.${ext}`;
    await page.evaluate(
      async ({ path, oldPath, ext }) => {
        const before =
          '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6"/></svg>';
        const after = before.replace("<rect ", '<rect id="same-shape" ');
        const url = (source: string) => "data:image/svg+xml;base64," + btoa(source);
        const canvas = document.createElement("canvas");
        canvas.width = 8;
        canvas.height = 6;
        const ctx = canvas.getContext("2d")!;
        const encode = (color: string) => {
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 8, 6);
          // WebKit can decode WebP even when its canvas encoder would return PNG.
          if (ext === "webp") {
            const bytes =
              color === "white"
                ? "UklGRiIAAABXRUJQVlA4TBYAAAAvB0ABAAfQ//73v/8BgCD8b5uI6H8I"
                : "UklGRiAAAABXRUJQVlA4TBMAAAAvB0ABAAcQEf0PAAThf9tERP9DAA==";
            return "data:image/webp;base64," + bytes;
          }
          return canvas.toDataURL("image/jpeg");
        };
        const left = ext === "svg" ? url(before) : encode("white");
        const right = ext === "svg" ? url(after) : encode("black");
        const handlers = window.__ipc.handlers;
        handlers.vcs_image_at = (args) => {
          if (args.path === oldPath && args.rev === "11111111") return left;
          if (args.path === path && args.rev === "22222222") return right;
          return null;
        };
        handlers.vcs_file_at = (args) => (args.path === oldPath ? before : after);
        const input = "/src/features/vcs/diffInput.ts";
        const { openDiff, commitFileDiffData } = await import(/* @vite-ignore */ input);
        await openDiff(
          commitFileDiffData(
            { id: "22222222", shortId: "22222222", parents: ["11111111"], repo: "/dev/acme-api" },
            { path: "current." + ext, oldPath: "original." + ext, kind: "renamed" },
          ),
        );
      },
      { path, oldPath, ext },
    );
    const toolbar = page.getByRole("toolbar", { name: "Image diff" });
    await toolbar.getByRole("button", { name: "Highlight changed pixels" }).click();
    await expectCount(page, ext === "svg" ? 0 : 48);
    expect(await ipcCalls(page, "fs_read_image")).toEqual([]);
    if (ext === "svg") {
      await toolbar.getByRole("button", { name: "View source diff" }).click();
      const xml = page.locator(".cm-content").filter({ hasText: "same-shape" });
      await expect(xml).toBeVisible();
      await page.getByRole("button", { name: "Image preview" }).click();
      await expect(xml).toBeHidden();
      await expect(page.getByRole("button", { name: "View source diff" })).toBeVisible();
    }
  });
}

// Identical opaque teal RGBA rows encoded with zlib levels 0 and 9. The cropped version removes the rightmost column.
const originalPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAPklEQVR4AQEzAMz/AACAgP8AgID/AICA/wCAgP8AAICA/wCAgP8AgID/AICA/wAAgID/AICA/wCAgP8AgID/UTEX9btCu2YAAAAASUVORK5CYII=";
const recompressedPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAEUlEQVR42mNgaGj4j4IJCgAAUTEX9X/prpgAAAAASUVORK5CYII=";
const croppedPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAEElEQVR42mNgaGj4D8c4OQBRFBH4p8q4GwAAAABJRU5ErkJggg==";

for (const [scenario, count] of [
  ["recompressed", 0],
  ["cropped", 3],
  ["added", 12],
  ["deleted", 12],
] as const) {
  test(`shows ${count} changed pixels for historical PNGs (${scenario})`, async ({ workbench: page }) => {
    await stubDesktop(page);
    await page.evaluate(
      async ({ scenario, before, after }) => {
        const input = "/src/features/vcs/diffInput.ts";
        const { openDiff, commitFileDiffData } = await import(/* @vite-ignore */ input);
        window.__ipc.handlers.vcs_image_at = ({ rev }) =>
          "data:image/png;base64," + (rev === "11111111" ? before : after);
        const kind = scenario === "added" || scenario === "deleted" ? scenario : "modified";
        await openDiff(
          commitFileDiffData(
            { id: "22222222", shortId: "22222222", parents: ["11111111"], repo: "/dev/acme-api" },
            { path: "snapshot.png", kind },
          ),
        );
      },
      { scenario, before: originalPng, after: scenario === "cropped" ? croppedPng : recompressedPng },
    );
    if (scenario === "added" || scenario === "deleted") {
      const missing = scenario === "added" ? "(does not exist)" : "(deleted)";
      await expect(page.getByRole("region", { name: missing }).getByText("No image on this side")).toBeVisible();
      const rev = scenario === "added" ? "22222222" : "11111111";
      await expect(page.getByRole("img", { name: rev })).toBeVisible();
      const reads = await ipcCalls(page, "vcs_image_at");
      expect(new Set(reads.map((call) => call.rev))).toEqual(new Set([rev]));
    }
    await page.getByRole("button", { name: "Highlight changed pixels" }).click();
    await expectCount(page, count);
    if (scenario === "cropped") {
      const changed = await page.getByLabel("Pixel difference mask").evaluate((element) => {
        const ctx = (element as HTMLCanvasElement).getContext("2d")!;
        const rgba = ctx.getImageData(0, 0, 4, 3).data;
        return Array.from({ length: 12 }, (_, i) => i).filter((i) => rgba[i * 4] !== rgba[i * 4 + 1]);
      });
      expect(changed).toEqual([3, 7, 11]);
    }
  });
}
