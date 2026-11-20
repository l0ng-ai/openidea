import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

test("the file revision chooser previews commit messages and compares the selected revision", async ({
  workbench: page,
}) => {
  await openFromTree(page, "build.gradle.kts");
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const path = `${root}/build.gradle.kts`;
    const latest = "123abcd000000000000000000000000000000000";
    const previous = "456efab000000000000000000000000000000000";
    window.__ipc.handlers.vcs_revision_files = () => ["build.gradle.kts"];
    window.__ipc.handlers.vcs_log = () => [
      {
        id: latest,
        shortId: "123abcd",
        author: "Lena Park",
        timeMs: Date.now(),
        summary: "Update reviewed totals",
        message: "Update reviewed totals",
        messageTruncated: true,
      },
      {
        id: previous,
        shortId: "456efab",
        author: "Morgan Chen",
        timeMs: Date.UTC(2025, 9, 18),
        summary: "Include October adjustments",
        message: "Include October adjustments\n\nUse the corrected quantities from the October review.",
      },
    ];
    window.__ipc.handlers.vcs_log_details_batch = () => [
      { message: "Update reviewed totals\n\nUse the totals reviewed by the release team." },
    ];
    window.__ipc.handlers.vcs_file_at = () => "val reviewedTotal = 28\n";
    window.__ipc.handlers.vcs_file_mode = () => "100644";

    const storeModule = "/src/features/vcs/store.ts";
    const historyModule = "/src/features/vcs/fileRevisions.ts";
    const contextModule = "/src/platform/context.ts";
    const actionsModule = "/src/platform/actions.ts";
    const { useVcs } = await import(/* @vite-ignore */ storeModule);
    const { hasFileHistory, trackFileHistory } = await import(/* @vite-ignore */ historyModule);
    const { setContext } = await import(/* @vite-ignore */ contextModule);
    const { executeAction } = await import(/* @vite-ignore */ actionsModule);
    useVcs.setState({ roots: [root], heads: { [root]: { headCommit: latest } }, statusLoaded: true });
    trackFileHistory();
    await expectFileHistory();
    setContext("vcsAvailable", true);
    await executeAction("vcs.compareWithRevision", path);

    async function expectFileHistory() {
      for (let i = 0; i < 20 && !hasFileHistory(path); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!hasFileHistory(path)) throw new Error("The sample file has no tracked history");
    }
  });

  const chooser = page.getByRole("dialog", { name: "Compare with Revision…" });
  const search = chooser.getByRole("textbox", { name: "Search file revisions" });
  const revisions = chooser.getByRole("listbox", { name: "File revisions" });
  const message = chooser.getByRole("region", { name: "Commit message" });
  await expect(revisions.getByRole("option")).toHaveCount(2);
  await expect(message).toContainText("Use the totals reviewed by the release team.");
  await expect
    .poll(() => ipcCalls(page, "vcs_log_details_batch"))
    .toEqual([
      expect.objectContaining({
        repo: "/dev/acme-api",
        revisions: ["123abcd000000000000000000000000000000000"],
      }),
    ]);

  const firstAuthor = await revisions.getByText("Lena Park", { exact: true }).boundingBox();
  const secondAuthor = await revisions.getByText("Morgan Chen", { exact: true }).boundingBox();
  expect(Math.abs(firstAuthor!.x - secondAuthor!.x)).toBeLessThan(1);
  await search.press("Tab");
  await expect(message).toBeFocused();
  await search.press("ArrowDown");
  await expect(revisions.getByRole("option", { name: /Morgan Chen/ })).toHaveAttribute("aria-selected", "true");
  await expect(message).toContainText("Use the corrected quantities from the October review.");

  await page.setViewportSize({ width: 480, height: 350 });
  const listBox = (await revisions.boundingBox())!;
  const messageBox = (await message.boundingBox())!;
  expect(messageBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height - 1);
  expect(messageBox.y + messageBox.height).toBeLessThanOrEqual(350);
  await search.fill("unmatched");
  await expect(revisions).toContainText("No commits");
  await expect(message).not.toContainText("Use the corrected quantities from the October review.");
  await search.fill("October adjustments");
  await expect(revisions.getByRole("option")).toHaveCount(1);
  await expect(message).toContainText("Use the corrected quantities from the October review.");
  await search.press("Enter");
  await expect(chooser).toBeHidden();
  await expect
    .poll(() => ipcCalls(page, "vcs_file_at"))
    .toContainEqual({
      path: "/dev/acme-api/build.gradle.kts",
      rev: "456efab000000000000000000000000000000000",
    });
});
