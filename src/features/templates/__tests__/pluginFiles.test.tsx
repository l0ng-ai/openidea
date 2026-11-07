import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewFileDialogHost, openNewFileDialog } from "../files/NewFileDialog";
import { useI18n } from "@/platform/i18n";
import { createFromTemplate } from "../files/create";
import type { FileTemplate } from "../files/model";

vi.mock("../files/create", async (original) => ({
  ...(await original<typeof import("../files/create")>()),
  packageFor: vi.fn(async () => "com.acme"),
  createFromTemplate: vi.fn(async (_t, _k, _d, _n, done) => {
    done?.();
    return "/p/file";
  }),
}));

afterEach(() => vi.clearAllMocks());

const template = (extra: Partial<FileTemplate> = {}): FileTemplate => ({
  id: "plugin.demo.repo",
  name: "Repository",
  icon: "file",
  extension: "java",
  nameStyle: "asis",
  kinds: [{ id: "file", label: "Repository", body: "$ENTITY$ $PACKAGE$ $END$" }],
  ...extra,
});

function open(t: FileTemplate) {
  render(<NewFileDialogHost />);
  act(() => openNewFileDialog({ directory: "/p", template: t }));
}

describe("plugin file creation dialog", () => {
  it("creates a fixed dotfile without asking for a name", async () => {
    open(template({ fileName: ".dockerignore" }));
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    await waitFor(() => expect(createFromTemplate).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createFromTemplate).mock.calls[0]![3]).toBe(".dockerignore");
  });

  it("asks all variables together, validates them and creates only on submit", async () => {
    open(
      template({
        variables: [
          { name: "ENTITY", prompt: "Entity class" },
          { name: "TABLE", prompt: "Table" },
        ],
      }),
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "OrderRepository" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByText("Enter a value for each variable")).toBeInTheDocument();
    expect(createFromTemplate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Entity class"), { target: { value: "Order" } });
    fireEvent.change(screen.getByLabelText("Table"), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createFromTemplate).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createFromTemplate).mock.calls[0]![5]).toEqual({ ENTITY: "Order", TABLE: "orders" });
  });

  it("cancels fixed-name variables without creating anything", () => {
    open(template({ fileName: ".gitattributes", variables: [{ name: "FILTER", prompt: "Filter" }] }));
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "lfs" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(createFromTemplate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("preserves plugin prompts when they collide with the IDE text catalog", () => {
    const texts = useI18n.getState().texts;
    useI18n.setState({ texts: { Cancel: "Annuler" } });
    try {
      open(template({ variables: [{ name: "FILTER", prompt: "Cancel" }] }));
      expect(screen.getByRole("textbox", { name: "Cancel" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Annuler" })).toBeInTheDocument();
    } finally {
      useI18n.setState({ texts });
    }
  });

  it.each([
    { field: "Name", ime: { isComposing: true } },
    { field: "Name", ime: { keyCode: 229 } },
    { field: "Filter", ime: { isComposing: true } },
    { field: "Filter", ime: { keyCode: 229 } },
  ])("does not submit while confirming IME text (%j)", async ({ field, ime }) => {
    open(
      template(
        field === "Name" ? {} : { fileName: ".gitattributes", variables: [{ name: "FILTER", prompt: "Filter" }] },
      ),
    );
    fireEvent.change(screen.getByLabelText(field), { target: { value: "文本" } });
    fireEvent.keyDown(screen.getByLabelText(field), { key: "Enter", ...ime });
    expect(createFromTemplate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText(field), { key: "Enter" });
    await waitFor(() => expect(createFromTemplate).toHaveBeenCalledTimes(1));
  });

  it("does not create when the variables dialog closes with Escape", () => {
    open(template({ variables: [{ name: "ENTITY", prompt: "Entity class" }] }));
    fireEvent.keyDown(screen.getByLabelText("Entity class"), { key: "Escape" });
    expect(createFromTemplate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
