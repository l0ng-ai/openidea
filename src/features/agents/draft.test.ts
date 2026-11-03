import { expect, it } from "vitest";
import { savedDraft } from "./store";

it("runs tasks in the local checkout unless the user picked a worktree", () => {
  expect(savedDraft({}).isolation).toBe("local");
  // Saved before the choice was recorded: `worktree` was only the old default.
  expect(savedDraft({ provider: "codex", isolation: "worktree" })).toMatchObject({
    provider: "codex",
    isolation: "local",
  });
  expect(savedDraft({ isolation: "worktree", isolationChosen: true }).isolation).toBe("worktree");
  expect(savedDraft({ isolation: "local", isolationChosen: true }).isolation).toBe("local");
});
