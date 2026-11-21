import type { Page } from "@playwright/test";
import type { ChangelistState } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function action(page: Page, id: string, arg?: string[]) {
  await page.evaluate(
    async ({ id, arg }) => {
      const actions = "/src/platform/actions.ts";
      const { executeAction } = await import(/* @vite-ignore */ actions);
      await executeAction(id, arg);
    },
    { id, arg },
  );
}

async function savedLists(page: Page) {
  const last = (await ipcCalls(page, "vcs_changelists_save")).at(-1);
  return last?.changelists as ChangelistState | undefined;
}

test("changelist forms align the fields and preserve multiline comments through create, edit and move", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await stubDesktop(page);
  await page.evaluate(async () => {
    const root = "/dev/acme-api";
    const vcsModule = "/src/features/vcs/store.ts";
    const { useVcs } = await import(/* @vite-ignore */ vcsModule);
    useVcs.setState({
      available: true,
      root,
      repo: root,
      roots: [root],
      status: [{ path: root + "/build.gradle.kts", relPath: "build.gradle.kts", staged: null, unstaged: "modified" }],
    });
    const listModule = "/src/features/vcs/changelists.ts";
    const { initialChangelists, useChangelists } = await import(/* @vite-ignore */ listModule);
    useChangelists.setState({
      state: {
        ...initialChangelists(),
        lists: [
          ...initialChangelists().lists,
          { id: "inbox", name: "Review inbox", comment: "Choose a reviewer before merging." },
          { id: "unsorted", name: "Unsorted" },
        ],
        files: { "build.gradle.kts": "default" },
      },
      loaded: true,
    });
    window.__ipc.handlers.vcs_changelists_save = () => null;
    const context = "/src/platform/context.ts";
    const { setContext } = await import(/* @vite-ignore */ context);
    setContext("vcsAvailable", true);
  });

  await action(page, "vcs.changelist.new");
  const create = page.getByRole("dialog", { name: "New Changelist", exact: true });
  const name = create.getByRole("textbox", { name: "Name:", exact: true });
  const comment = create.getByRole("textbox", { name: "Comment:", exact: true });
  const ok = create.getByRole("button", { name: "OK", exact: true });
  await expect(name).toBeFocused();
  await expect(ok).toBeDisabled();
  const nameLabel = (await create.getByText("Name:", { exact: true }).boundingBox())!;
  const nameField = (await name.boundingBox())!;
  expect(nameLabel.x + nameLabel.width).toBeLessThan(nameField.x);
  const commentLabel = (await create.getByText("Comment:", { exact: true }).boundingBox())!;
  const commentField = (await comment.boundingBox())!;
  expect(Math.abs(nameField.x - commentField.x)).toBeLessThan(1);
  expect(commentLabel.x + commentLabel.width).toBeLessThan(commentField.x);
  expect(commentField.height).toBeGreaterThan(76);
  await expect(create.getByText("Name:", { exact: true })).toHaveCSS(
    "font-size",
    await name.evaluate((el) => getComputedStyle(el).fontSize),
  );
  await name.fill("Changes");
  await expect(name).toHaveAccessibleDescription(/already exists/);
  await expect(ok).toBeDisabled();

  await name.fill("Release review");
  await comment.fill("Review the totals.\nAsk for a second check.");
  await create.getByRole("checkbox", { name: "Set active" }).check();
  await ok.click();
  await expect
    .poll(async () => {
      const state = await savedLists(page);
      return state?.lists.find((list) => list.id === state.active)?.comment;
    })
    .toBe("Review the totals.\nAsk for a second check.");

  await action(page, "vcs.changelist.edit");
  const edit = page.getByRole("dialog", { name: "Edit Changelist", exact: true });
  await expect(edit.getByRole("textbox", { name: "Name:", exact: true })).toHaveValue("Release review");
  const editComment = edit.getByRole("textbox", { name: "Comment:", exact: true });
  await expect(editComment).toHaveValue("Review the totals.\nAsk for a second check.");
  await expect(edit.getByRole("checkbox", { name: "Set active" })).toBeDisabled();
  await editComment.fill("Review complete.\nReady for the release checklist.");
  await edit.getByRole("button", { name: "OK", exact: true }).click();
  await expect
    .poll(async () => (await savedLists(page))?.lists.find((list) => list.name === "Release review")?.comment)
    .toBe("Review complete.\nReady for the release checklist.");

  await action(page, "vcs.changelist.move", ["/dev/acme-api/build.gradle.kts"]);
  const move = page.getByRole("dialog", { name: "Move Changes to Another Changelist" });
  const newName = move.getByRole("textbox", { name: "Name:", exact: true });
  const targetComment = move.getByRole("textbox", { name: "Comment:", exact: true });
  const moveOk = move.getByRole("button", { name: "OK", exact: true });
  await expect(newName).toBeFocused();
  await expect(newName).toHaveValue("Release review");
  await expect(targetComment).toHaveAttribute("readonly", "");
  await newName.press("ArrowDown");
  const options = page.getByRole("listbox", { name: "Target changelist" });
  await expect(options).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(options).toBeHidden();
  await expect(newName).toBeFocused();
  await newName.press("ArrowDown");
  await expect(options.getByRole("option", { name: "Changes", exact: true })).toHaveCount(0);
  await options.getByRole("option", { name: "Review inbox", exact: true }).click();
  await expect(newName).toHaveValue("Review inbox");
  await expect(targetComment).toHaveValue("Choose a reviewer before merging.");
  await newName.fill("Changes");
  await expect(newName).toHaveAccessibleDescription(/already exists/);
  await expect(moveOk).toBeDisabled();

  await page.setViewportSize({ width: 400, height: 540 });
  const stackedName = (await newName.boundingBox())!;
  const stackedLabel = (await move.getByText("Name:", { exact: true }).boundingBox())!;
  expect(stackedLabel.y + stackedLabel.height).toBeLessThanOrEqual(stackedName.y);
  expect(Math.abs(stackedLabel.x - stackedName.x)).toBeLessThan(1);
  await newName.fill("Ready to ship");
  await expect(targetComment).toBeEditable();
  await targetComment.fill("Move the reviewed change here.");
  await newName.fill("Unsorted");
  await expect(targetComment).toHaveAttribute("readonly", "");
  await expect(targetComment).toHaveValue("");
  await newName.fill("Ready to ship");
  await expect(targetComment).toHaveValue("Move the reviewed change here.");
  await moveOk.click();
  await expect
    .poll(async () => {
      const state = await savedLists(page);
      return state?.lists.find((list) => list.id === state.files?.["build.gradle.kts"])?.name;
    })
    .toBe("Ready to ship");
});
