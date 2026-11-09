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

describe("prompt dialog prefilled for replacement", () => {
  it("selects the prefilled value so typing replaces it", async () => {
    const user = userEvent.setup();
    render(<VcsDialogHost />);
    act(() => void open("feature/ui"));
    const input = await screen.findByRole<HTMLInputElement>("textbox", { name: "New branch name:" });
    await waitFor(() => expect(input.selectionEnd).toBe("feature/ui".length));
    expect(input.selectionStart).toBe(0);
    await user.keyboard("fix");
    expect(input).toHaveValue("fix");
  });

  it("leaves an empty field alone", async () => {
    render(<VcsDialogHost />);
    act(() => void open());
    const input = await screen.findByRole<HTMLInputElement>("textbox", { name: "New branch name:" });
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(0);
  });

  it("keeps the caret when an edited field is programmatically focused again", async () => {
    const user = userEvent.setup();
    render(<VcsDialogHost />);
    act(() => void open("feature/ui"));
    const input = await screen.findByRole<HTMLInputElement>("textbox", { name: "New branch name:" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard("fix");
    input.setSelectionRange(1, 1);
    act(() => {
      input.blur();
      input.focus();
    });
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(1);
    await user.keyboard("x");
    expect(input).toHaveValue("fxix");
  });
});

describe("prompt dialog checkbox", () => {
  const openWithUpstream = (checkbox: boolean) =>
    promptText({
      title: "Rename Branch topic",
      label: "New branch name:",
      initial: "topic",
      okLabel: "Rename",
      checkbox: checkbox ? { label: "Unset upstream branch", initial: false } : undefined,
    });

  it("is offered unchecked and reported back", async () => {
    const user = userEvent.setup();
    render(<VcsDialogHost />);
    let result: ReturnType<typeof openWithUpstream> | undefined;
    act(() => {
      result = openWithUpstream(true);
    });
    const box = await screen.findByRole("checkbox", { name: "Unset upstream branch" });
    expect(box).not.toBeChecked();
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await expect(result).resolves.toEqual({ value: "topic", checked: true });
  });

  it("is missing when the branch tracks nothing", async () => {
    render(<VcsDialogHost />);
    act(() => void openWithUpstream(false));
    await screen.findByRole("textbox", { name: "New branch name:" });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
