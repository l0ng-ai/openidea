import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { cleanUpBranchNameOnTyping } from "@/platform/gitRefName";
import { VcsDialogHost, promptText } from "../dialogs";
import { validateBranchName } from "../branchOps";

const open = (initial = "") =>
  promptText({
    title: "Create New Branch",
    label: "New branch name:",
    initial,
    okLabel: "Create",
    sanitize: cleanUpBranchNameOnTyping,
    validate: validateBranchName,
  });

// The dialog stack is module state: close whatever a test left open.
afterEach(async () => {
  for (const cancel of screen.queryAllByRole("button", { name: "Cancel" })) await userEvent.click(cancel);
});

describe("prompt dialog with a sanitizer (branch name)", () => {
  it("replaces a typed space and keeps Create enabled", async () => {
    const user = userEvent.setup();
    render(<VcsDialogHost />);
    let result: ReturnType<typeof open> | undefined;
    act(() => {
      result = open();
    });
    const input = await screen.findByRole("textbox", { name: "New branch name:" });
    await user.type(input, "fix login  redirect");
    expect(input).toHaveValue("fix-login-redirect");
    expect(screen.queryByText("Branch name contains invalid characters")).toBeNull();
    const create = screen.getByRole("button", { name: "Create" });
    expect(create).toBeEnabled();
    await user.click(create);
    await expect(result).resolves.toEqual({ value: "fix-login-redirect", checked: false });
  });

  it("converts spaces in pasted text", async () => {
    const user = userEvent.setup();
    render(<VcsDialogHost />);
    act(() => void open());
    const input = await screen.findByRole("textbox", { name: "New branch name:" });
    await user.click(input);
    await user.paste("feature/add new thing");
    expect(input).toHaveValue("feature/add-new-thing");
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it("keeps the caret after the rewritten character when editing mid-text", async () => {
    const user = userEvent.setup();
    render(<VcsDialogHost />);
    act(() => void open("ab"));
    const input = await screen.findByRole<HTMLInputElement>("textbox", { name: "New branch name:" });
    input.setSelectionRange(1, 1);
    await user.keyboard(" ");
    expect(input).toHaveValue("a-b");
    await waitFor(() => expect(input.selectionStart).toBe(2));
    await user.keyboard("x");
    expect(input).toHaveValue("a-xb");
  });
});
