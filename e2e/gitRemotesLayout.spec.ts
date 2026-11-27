import type { Remote, RemoteEdit } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

test("keeps remote columns, actions and editing usable in a short window", async ({ workbench: page }) => {
  await page.setViewportSize({ width: 450, height: 420 });
  await stubDesktop(page);
  const originalUrl = "https://git.example.test/engineering/international-settlement/replica-18.git";
  await page.evaluate(async (originalUrl) => {
    let remotes: Remote[] = Array.from({ length: 18 }, (_, i) => ({
      name: i === 0 ? "origin" : `mirror-${i + 1}`,
      url: i === 17 ? originalUrl : `https://git.example.test/project/repository-${i + 1}.git`,
    }));
    window.__ipc.handlers.vcs_remotes = () => remotes;
    window.__ipc.handlers.vcs_edit_remote = ({ edit }) => {
      const patch = edit as RemoteEdit;
      if (patch.op === "edit") {
        remotes = remotes.map((remote) =>
          remote.name === patch.name ? { name: patch.new_name, url: patch.url } : remote,
        );
      }
      return null;
    };
    window.__ipc.handlers.vcs_branches = () => [];
    const module = "/src/features/vcs/gitMenuDialogs.tsx";
    const { showManageRemotes } = await import(/* @vite-ignore */ module);
    showManageRemotes();
  }, originalUrl);

  const dialog = page.getByRole("dialog", { name: "Git Remotes", exact: true });
  await expect(dialog.getByText(originalUrl, { exact: true })).toBeVisible();
  const table = dialog.getByRole("grid", { name: "Remotes", exact: true });
  const name = table.getByRole("columnheader", { name: "Name", exact: true });
  const url = table.getByRole("columnheader", { name: "URL", exact: true });
  await expect(name).toBeInViewport({ ratio: 1 });
  await expect(url).toBeInViewport({ ratio: 1 });
  const first = table.getByRole("row", { name: /^origin / });
  const last = table.getByRole("row", { name: /^mirror-18 / });
  await first.click();
  await page.keyboard.press("End");
  await expect(last).toBeFocused();
  await expect(last).toHaveAttribute("aria-selected", "true");
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(url).toBeInViewport({ ratio: 1 });
  const cell = last.getByRole("gridcell", { name: originalUrl, exact: true });
  await expect(cell).toHaveAttribute("title", originalUrl);
  expect((await cell.boundingBox())!.x).toBeCloseTo((await url.boundingBox())!.x, 0);
  const scroller = table.locator("..");
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(dialog.getByRole("button", { name: "Add Remote…" })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "OK", exact: true })).toBeInViewport({ ratio: 1 });

  await page.keyboard.press("Enter");
  const edit = page.getByRole("dialog", { name: "Edit Remote", exact: true });
  const editName = edit.getByRole("textbox", { name: "Name", exact: true });
  const editUrl = edit.getByRole("textbox", { name: "URL", exact: true });
  await expect(editName).toHaveValue("mirror-18");
  await expect(editUrl).toHaveValue(originalUrl);
  expect((await editName.boundingBox())!.x).toBeCloseTo((await editUrl.boundingBox())!.x, 0);
  const nextUrl = "https://git.example.test/repository-18.git";
  await editUrl.fill(nextUrl);
  await edit.getByRole("button", { name: "OK", exact: true }).click();
  await expect(last).toContainText(nextUrl);
  await expect(last).toBeFocused();
  expect(await ipcCalls(page, "vcs_edit_remote")).toMatchObject([
    { edit: { op: "edit", name: "mirror-18", new_name: "mirror-18", url: nextUrl } },
  ]);
});
