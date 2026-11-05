import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { GithubDialogHost } from "../ui/dialogs";
import { remoteBranchNameDialog } from "./RemoteBranchDialog";

it("turns spaces typed in the remote branch name into separators", async () => {
  const user = userEvent.setup();
  render(<GithubDialogHost />);
  let result: Promise<string | null> | undefined;
  act(() => {
    result = remoteBranchNameDialog("");
  });
  const input = await screen.findByRole("textbox", { name: "Remote branch name" });
  await user.type(input, "my feature");
  expect(input).toHaveValue("my-feature");
  await user.click(screen.getByRole("button", { name: "OK" }));
  await expect(result).resolves.toBe("my-feature");
});
