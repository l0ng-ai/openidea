import type { Page } from "@playwright/test";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

async function seedReview(page: Page) {
  await stubDesktop(page);
  await page.evaluate(async () => {
    const project = "/src/platform/project.ts";
    const context = "/src/platform/context.ts";
    const repositoryStore = "/src/features/github/data/repository.ts";
    const pullRequests = "/src/features/github/data/pullRequest.ts";
    const { useProject } = await import(/* @vite-ignore */ project);
    const { setContext } = await import(/* @vite-ignore */ context);
    const { useGhRepository } = await import(/* @vite-ignore */ repositoryStore);
    const { setPullRequestData } = await import(/* @vite-ignore */ pullRequests);
    useProject.setState((s: { settings: { editor: unknown } }) => ({
      settings: {
        ...s.settings,
        editor: { ...(s.settings?.editor as object), fontFamily: "Courier New", fontSize: 17, lineHeight: 25 },
      },
    }));
    const coordinates = { owner: "sample", name: "settlement" };
    useGhRepository.setState({
      connection: {
        coordinates,
        repository: { id: "repository", nameWithOwner: "sample/settlement" },
        currentUser: { id: "reviewer", login: "reviewer" },
        root: null,
        remotes: [],
      },
    });
    setContext("githubConnected", true);
    setContext("githubCurrentBranchPullRequest", true);
    setPullRequestData(7, "details", () => ({ number: 7, viewerDidAuthor: false }));
    setPullRequestData(7, "pendingReview", () => ({ id: "draft-seven", state: "PENDING", commentsCount: 12 }));
  });
}

async function openReview(page: Page) {
  await page.evaluate(async () => {
    const actions = "/src/platform/actions.ts";
    const { executeAction } = await import(/* @vite-ignore */ actions);
    await executeAction("github.pullRequest.submitReview", 7);
  });
}

test("centers the unanchored composer, follows the editor font and reflows its review actions", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1120, height: 840 });
  await seedReview(page);
  await openReview(page);
  const popup = page.getByRole("dialog", { name: "Submit Review" });
  const editor = popup.getByRole("textbox", { name: "Review comment" });
  const verticalCenter = () =>
    popup.evaluate((el) => {
      const { top, height } = el.getBoundingClientRect();
      return Math.abs(top + height / 2 - innerHeight / 2);
    });
  await expect.poll(verticalCenter, { message: "verticalCenter at standard size" }).toBeLessThan(1);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveCSS("font-size", "17px");
  await expect(editor).toHaveCSS("line-height", "25px");
  await expect(editor).toHaveCSS("font-family", /Courier New/);
  await editor.fill("Please double-check the rounding step.");

  const grip = (await popup.getByRole("separator", { name: "Resize" }).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 56, grip.y + grip.height / 2 + 32);
  await page.mouse.up();
  await expect.poll(async () => (await popup.boundingBox())!.width).toBeGreaterThan(540);
  await page.setViewportSize({ width: 300, height: 400 });
  await expect.poll(verticalCenter, { message: "verticalCenter after shrinking" }).toBeLessThan(1);
  const approve = (await popup.getByRole("button", { name: "Approve", exact: true }).boundingBox())!;
  const comment = (await popup.getByRole("button", { name: "Comment", exact: true }).boundingBox())!;
  expect(comment.y).toBeGreaterThan(approve.y);
  expect(comment.x + comment.width).toBeLessThan(300);
  await expect(editor).toHaveValue("Please double-check the rounding step.");
  await editor.press("Escape");
  await expect(popup).toHaveCount(0);
  await openReview(page);
  await expect(editor).toHaveValue("Please double-check the rounding step.");
});

test("keeps anchored review controls and the comment visible after a long submission error", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 355, height: 390 });
  await seedReview(page);
  await page.evaluate(async () => {
    const path = "/src/features/github/details/SubmitReviewPopup.tsx";
    const { showSubmitReview } = await import(/* @vite-ignore */ path);
    const anchor = document.createElement("button");
    anchor.style.cssText = "position:fixed;top:350px;left:275px;";
    anchor.textContent = "Review anchor";
    document.body.append(anchor);
    window.__ipc.handlers.gh_api = ({ request }) => {
      const { query } = JSON.parse((request as { body: string }).body);
      if (!query.includes("submitPullRequestReview")) throw Error("Unexpected GitHub request");
      return JSON.stringify({ errors: [{ message: "Review request failed. " + "outdated-reference-".repeat(35) }] });
    };
    void showSubmitReview(7, anchor);
  });
  const popup = page.getByRole("dialog", { name: "Submit Review" });
  const editor = popup.getByRole("textbox", { name: "Review comment" });
  const button = popup.getByRole("button", { name: "Comment", exact: true });
  await editor.fill("Check the batch limit.");
  await button.click();
  const error = popup.getByRole("alert");
  await expect(error).toContainText("Review request failed.");
  await expect(button).toBeEnabled();
  await expect(editor).toHaveValue("Check the batch limit.");
  const box = (await popup.boundingBox())!;
  const buttonBox = (await button.boundingBox())!;
  expect(box.y + box.height).toBeLessThan(350);
  expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(box.y + box.height);
  expect(box.x + box.width).toBeLessThanOrEqual(355);
  await expect.poll(() => error.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const calls = await ipcCalls(page, "gh_api");
  expect(calls).toHaveLength(1);
  const { variables } = JSON.parse((calls[0]!.request as { body: string }).body);
  expect(variables).toEqual({ reviewId: "draft-seven", event: "COMMENT", body: "Check the batch limit." });
});
