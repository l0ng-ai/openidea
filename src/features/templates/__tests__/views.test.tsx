import { addContributedSnippets, SettingsPageFocusContext } from "@/workbench/contributions";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LiveTemplatesPage, groupTemplates } from "../settings/LiveTemplatesPage";
import { PostfixPage } from "../settings/PostfixPage";
import { FileTemplatesPage } from "../settings/FileTemplatesPage";
import { NewFileDialogHost, openNewFileDialog } from "../files/NewFileDialog";
import { ChooserHost } from "../popup/Chooser";
import { showChooser } from "../popup/store";
import { BUILTIN_TEMPLATES } from "../live/builtins";
import { removeTemplate, saveTemplate, useLiveTemplates } from "../live/store";
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

  it("duplicates a custom live template and selects the editable copy", () => {
    const source = {
      id: "user.duplicate-source",
      group: "Custom group",
      abbrev: "duplicate-me",
      description: "Source template",
      body: "const $NAME$ = $VALUE$;$END$",
      contexts: ["typescript", "sql-statement"],
      variables: [
        { name: "NAME", defaultValue: '"name"' },
        { name: "VALUE", defaultValue: '"value"' },
      ],
      enabled: false,
      scope: "any" as const,
    };
    saveTemplate(source);
    const previousIds = new Set(useLiveTemplates.getState().templates.map((t) => t.id));
    let copyId: string | undefined;
    const view = render(<LiveTemplatesPage />);
    try {
      fireEvent.click(screen.getByText(source.abbrev));
      const duplicate = screen.getByRole("button", { name: "Duplicate Template" });
      expect(duplicate).toBeEnabled();
      fireEvent.click(duplicate);

      const copy = useLiveTemplates.getState().templates.find((t) => !previousIds.has(t.id));
      if (!copy) throw new Error("Duplicate was not created");
      copyId = copy.id;
      expect(copy).toEqual({ ...source, id: copy.id, abbrev: "ABBREVIATION" });
      expect(useLiveTemplates.getState().custom.templates[copy.id]).toEqual(copy);
      expect(screen.getByRole("option", { selected: true })).toHaveTextContent("ABBREVIATION");
      expect(screen.getByLabelText("Abbreviation")).toHaveValue("ABBREVIATION");
      expect(screen.getByLabelText("Description")).toHaveValue(source.description);
      expect(screen.getByLabelText("Description")).toBeEnabled();
      expect(screen.getByLabelText("Group")).toHaveValue(source.group);
      expect(screen.getByLabelText("Template text")).toHaveValue(source.body);
      expect(screen.getByLabelText("Contexts")).toHaveValue(source.contexts.join(", "));
      expect(screen.getByLabelText("NAME default value")).toHaveValue('"name"');
      expect(screen.getByLabelText("VALUE default value")).toHaveValue('"value"');
    } finally {
      view.unmount();
      removeTemplate(source.id);
      if (copyId) removeTemplate(copyId);
    }
  });

  it("selects the template it was opened on (Save as Live Template)", async () => {
    saveTemplate({
      id: "user.saved",
      group: "User",
      abbrev: "abbr",
      description: "",
      body: "go($$x);",
      contexts: ["typescript"],
    });
    const consume = vi.fn();
    const page = (focus: string | null) => (
      <SettingsPageFocusContext.Provider value={{ focus, consume }}>
        <LiveTemplatesPage />
      </SettingsPageFocusContext.Provider>
    );
    const view = render(page(null));
    try {
      fireEvent.change(screen.getByLabelText("Filter templates"), { target: { value: "psvm" } });
      expect(screen.getByText("Select a template to edit it")).toBeInTheDocument();
      view.rerender(page("user.saved"));
      await waitFor(() => expect(consume).toHaveBeenCalledOnce());
      expect(screen.getByLabelText("Filter templates")).toHaveValue("");
      expect(screen.getByRole("option", { selected: true })).toHaveTextContent("abbr");
      expect(screen.getByLabelText("Template text")).toHaveValue("go($$x);");
    } finally {
      view.unmount();
      removeTemplate("user.saved");
    }
  });

  it("shows nothing selected when opened on a template that is gone", async () => {
    const consume = vi.fn();
    const view = render(
      <SettingsPageFocusContext.Provider value={{ focus: "user.missing", consume }}>
        <LiveTemplatesPage />
      </SettingsPageFocusContext.Provider>,
    );
    await waitFor(() => expect(consume).toHaveBeenCalledOnce());
    expect(screen.queryByRole("option", { selected: true })).toBeNull();
    expect(screen.getByText("Select a template to edit it")).toBeInTheDocument();
    view.unmount();
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

it("shows plugin snippets as read-only live templates and duplicates them as editable user templates", () => {
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
  const previousIds = new Set(useLiveTemplates.getState().templates.map((t) => t.id));
  let copyId: string | undefined;
  const view = render(<LiveTemplatesPage />);
  try {
    fireEvent.click(screen.getByText("selectrows"));
    expect(screen.getByLabelText("Description")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Template" })).toBeDisabled();
    expect(screen.getByLabelText("Enable selectrows")).toBeDisabled();

    const duplicate = screen.getByRole("button", { name: "Duplicate Template" });
    expect(duplicate).toBeEnabled();
    fireEvent.click(duplicate);
    const copy = useLiveTemplates.getState().templates.find((t) => !previousIds.has(t.id));
    if (!copy) throw new Error("Duplicate was not created");
    copyId = copy.id;
    expect(copy).toMatchObject({
      id: expect.stringMatching(/^user\./),
      group: "SQL plugin",
      abbrev: "ABBREVIATION",
      description: "Select rows",
      body: "SELECT $P1$$END$",
      contexts: ["sql"],
      scope: "any",
      variables: [{ name: "P1", defaultValue: '"column"' }],
    });
    expect(copy).not.toHaveProperty("pluginOrigin");
    expect(useLiveTemplates.getState().custom.templates[copy.id]).toEqual(copy);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("ABBREVIATION");
    expect(screen.getByLabelText("Description")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove Template" })).toBeEnabled();

    act(() => off());
    expect(screen.queryByText("selectrows")).toBeNull();
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("ABBREVIATION");
    expect(screen.getByLabelText("Template text")).toHaveValue("SELECT $P1$$END$");
  } finally {
    act(() => off());
    view.unmount();
    if (copyId) removeTemplate(copyId);
  }
});
