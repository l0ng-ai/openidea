import { addContributedSnippets } from "@/workbench/contributions";
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { LiveTemplatesPage, groupTemplates } from "../settings/LiveTemplatesPage";
import { PostfixPage } from "../settings/PostfixPage";
import { FileTemplatesPage } from "../settings/FileTemplatesPage";
import { NewFileDialogHost, openNewFileDialog } from "../files/NewFileDialog";
import { ChooserHost } from "../popup/Chooser";
import { showChooser } from "../popup/store";
import { BUILTIN_TEMPLATES } from "../live/builtins";
import { useLiveTemplates } from "../live/store";
import { usePostfixSettings } from "../postfix/store";
import { reloadFileTemplates, resetInclude, saveInclude, setTemplateScheme, useFileTemplates } from "../files/store";
import { useProject } from "@/platform/project";
import type { ProjectInfo } from "@/platform/ipc";

describe("settings pages", () => {
  it("groups and filters live templates", () => {
    const groups = groupTemplates(BUILTIN_TEMPLATES, "psvm");
    expect(groups.map(([g]) => g)).toEqual(["Java"]);
  });

  it("edits a live template", () => {
    render(<LiveTemplatesPage />);
    fireEvent.click(screen.getAllByText("psvm")[0]!);
    const desc = screen.getByLabelText("Description") as HTMLInputElement;
    fireEvent.change(desc, { target: { value: "Main method" } });
    expect(useLiveTemplates.getState().templates.find((t) => t.id === "java.psvm")?.description).toBe("Main method");
    expect(screen.getByText("Restore Default")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Restore Default"));
    expect(useLiveTemplates.getState().templates.find((t) => t.id === "java.psvm")?.description).toBe("main() method");
  });

  it("toggles postfix templates", () => {
    render(<PostfixPage />);
    fireEvent.click(screen.getByLabelText("Enable .if"));
    expect(usePostfixSettings.getState().disabled).toContain("ts.if");
    fireEvent.click(screen.getByLabelText("Enable .if"));
    expect(usePostfixSettings.getState().disabled).not.toContain("ts.if");
  });

  it("renders file templates", () => {
    render(<FileTemplatesPage />);
    expect(screen.getByText("Kotlin Class/File")).toBeInTheDocument();
  });

  it("edits includes and code templates in their tabs", () => {
    render(<FileTemplatesPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Includes" }));
    fireEvent.change(screen.getByLabelText("Include body"), { target: { value: "// header" } });
    expect(useFileTemplates.getState().includes.find((f) => f.name === "File Header")?.body).toBe("// header");
    fireEvent.click(screen.getByText("Restore Default"));
    expect(useFileTemplates.getState().includes.find((f) => f.name === "File Header")?.body).toBe("");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(screen.getByText("JUnit5 Test Method")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Code template body"), { target: { value: "@Test\nvoid t() {}\n" } });
    expect(useFileTemplates.getState().codeTemplates[0]?.body).toBe("@Test\nvoid t() {}\n");
    fireEvent.click(screen.getByText("Restore Default"));
  });

  it("keeps a project scheme seeded from Default", () => {
    useProject.setState({ project: { root: "/proj", name: "proj" } as unknown as ProjectInfo });
    reloadFileTemplates();
    saveInclude({ name: "File Header", body: "// default" });
    setTemplateScheme("project");
    expect(useFileTemplates.getState().scheme).toBe("project");
    expect(useFileTemplates.getState().includes[0]?.body).toBe("// default");
    saveInclude({ name: "File Header", body: "// project" });
    setTemplateScheme("default");
    expect(useFileTemplates.getState().includes[0]?.body).toBe("// default");
    setTemplateScheme("project");
    expect(useFileTemplates.getState().includes[0]?.body).toBe("// project");
    setTemplateScheme("default");
    resetInclude("File Header");
    useProject.setState({ project: null });
    reloadFileTemplates();
  });
});

describe("dialogs", () => {
  it("shows the template chooser then the name step", () => {
    render(<NewFileDialogHost />);
    act(() => openNewFileDialog({ directory: "/p/src/main/kotlin/com/acme" }));
    fireEvent.click(screen.getByText("Kotlin Class/File"));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByText("Data class")).toBeInTheDocument();
  });

  it("prefills fixed names and follows the kind's extension", () => {
    render(<NewFileDialogHost />);
    act(() => openNewFileDialog({ directory: "/p", templateId: "dockerfile" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Dockerfile");
    act(() => openNewFileDialog({ directory: "/p", templateId: "stylesheet" }));
    expect(screen.getByLabelText("Name")).toHaveAttribute("placeholder", "Name (.css)");
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "ArrowDown" });
    expect(screen.getByLabelText("Name")).toHaveAttribute("placeholder", "Name (.scss)");
  });

  it("names an ad-hoc template from another feature", () => {
    render(<NewFileDialogHost />);
    act(() =>
      openNewFileDialog({
        directory: "/p",
        template: {
          id: "http-request",
          name: "HTTP Request",
          icon: "file-http",
          extension: "http",
          nameStyle: "asis",
          kinds: [{ id: "request", label: "HTTP Request", body: "GET /\n" }],
        },
      }),
    );
    expect(screen.getByRole("dialog", { name: "New HTTP Request" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveAttribute("placeholder", "Name (.http)");
  });

  it("chooser filters by typing and picks with Enter", () => {
    let picked = "";
    render(<ChooserHost />);
    act(() =>
      showChooser({
        title: "Test",
        anchor: { x: 0, y: 0 },
        filterable: true,
        items: [
          { key: "a", label: "fori" },
          { key: "b", label: "iter" },
        ],
        onPick: (i) => (picked = i.key),
      }),
    );
    const body = screen.getByRole("dialog").querySelector("[tabindex='0']")!;
    fireEvent.keyDown(body, { key: "i" });
    fireEvent.keyDown(body, { key: "t" });
    fireEvent.keyDown(body, { key: "Enter" });
    expect(picked).toBe("b");
  });

  it("chooser picks by mnemonic and skips section rows", () => {
    let picked = "";
    render(<ChooserHost />);
    act(() =>
      showChooser({
        title: "Surround With",
        anchor: { x: 0, y: 0 },
        mnemonics: true,
        items: [
          { key: "if", label: "if", mnemonic: "1" },
          { key: "s", label: "Live templates", section: true },
          { key: "t", label: "T", detail: "tag", mnemonic: "T", mnemonicIndex: 0 },
        ],
        onPick: (i) => (picked = i.key),
      }),
    );
    const body = screen.getByRole("dialog").querySelector("[tabindex='0']")!;
    fireEvent.keyDown(body, { key: "ArrowDown" });
    fireEvent.keyDown(body, { key: "Enter" });
    expect(picked).toBe("t");
    act(() =>
      showChooser({
        title: "Surround With",
        anchor: { x: 0, y: 0 },
        mnemonics: true,
        items: [
          { key: "if", label: "if", mnemonic: "1" },
          { key: "t", label: "T", mnemonic: "T", mnemonicIndex: 0 },
        ],
        onPick: (i) => (picked = i.key),
      }),
    );
    fireEvent.keyDown(screen.getByRole("dialog").querySelector("[tabindex='0']")!, { key: "t" });
    expect(picked).toBe("t");
  });
});

it("shows plugin snippets as read-only live templates and withdraws them with the plugin", () => {
  const off = addContributedSnippets([
    {
      id: "plugin-snippet:test:file:0",
      pluginName: "SQL plugin",
      language: "sql",
      prefixes: ["selectrows"],
      body: "SELECT ${1:column}$0",
      description: "Select rows",
    },
  ]);
  const view = render(<LiveTemplatesPage />);
  fireEvent.click(screen.getByText("selectrows"));
  expect(screen.getByLabelText("Description")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove Template" })).toBeDisabled();
  expect(screen.getByLabelText("Enable selectrows")).toBeDisabled();
  act(() => off());
  expect(screen.queryByText("selectrows")).toBeNull();
  view.unmount();
});
