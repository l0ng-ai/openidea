import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { LanguageInfo } from "@/bindings";
import { applicableTemplates, type LiveTemplate } from "@/features/templates/live/model";

const read = vi.fn();
const set = vi.fn();
const notify = vi.fn();
const editor = { fontFamily: "JetBrains Mono", fontSize: 13, customSchemes: {}, colorOverrides: {} };
const python: LanguageInfo = {
  id: "python",
  name: "Python",
  extensions: ["py"],
  uiMode: "Python",
  lineComment: "#",
  blockComment: null,
  indent: null,
};

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      settingsReadJetbrains: (path: string) => read(path),
      settingsGetGlobal: async () => ({ editor }),
      settingsSet: (scope: string, key: string, value: string) => set(scope, key, value),
      languages: async () => [python],
    },
  };
});
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));

const { importJetBrainsSettings } = await import("../jetbrainsSettings");
const { MessagesHost } = await import("@/workbench/messages");
const { BUILTIN_TEMPLATES } = await import("@/features/templates/live/builtins");
const { LIVE_TEMPLATES_KEY, mergeTemplates, saveTemplate, useLiveTemplates } =
  await import("@/features/templates/live/store");

const empty = { templates: {}, deleted: [] };
const xml = (body = "for $ITEM$ in $ITEMS$: $END$") =>
  '<templateSet name="Python">' +
  `<template name="iter" description="Iterate items" value="${body}">` +
  '<variable name="ITEM" expression="suggestVariableName()" defaultValue="&quot;item&quot;" alwaysStopAt="false" />' +
  '<variable name="UNSUPPORTED" expression="groovyScript(&quot;1&quot;)" defaultValue="&quot;fallback&quot;" />' +
  '<context><option name="Python" value="true" /></context></template>' +
  '<template name="brain" value="$END$"><context><option name="Brainfuck" value="true" /></context></template>' +
  "</templateSet>";
const bundle = (files: Record<string, string>) => ({ status: "ok", data: { entries: Object.keys(files), files } });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem(LIVE_TEMPLATES_KEY);
  useLiveTemplates.setState({ custom: empty, templates: mergeTemplates(BUILTIN_TEMPLATES, empty) });
  read.mockResolvedValue(bundle({ "templates/Python.xml": xml() }));
  set.mockResolvedValue({ status: "ok", data: { editor } });
  // jsdom has no canvas: settings without templates still fall back to the font size.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => vi.restoreAllMocks());

async function start(path: string): Promise<{ done: Promise<void> }> {
  let done!: Promise<void>;
  await act(async () => {
    done = importJetBrainsSettings(path);
  });
  return { done };
}

async function choose(button: "Cancel" | "Import", done: Promise<void>) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: button }));
    await done;
  });
}

it("cancelling writes neither settings nor live templates", async () => {
  const keep: LiveTemplate = {
    id: "user.keep",
    group: "User",
    abbrev: "keep",
    description: "",
    body: "keep",
    contexts: ["python"],
  };
  saveTemplate(keep);
  saveTemplate({ ...BUILTIN_TEMPLATES[0]!, body: "my built-in edit" });
  const before = useLiveTemplates.getState().custom;
  const stored = localStorage.getItem(LIVE_TEMPLATES_KEY);
  render(<MessagesHost />);

  const { done } = await start("/settings/PyCharm2026.1");
  expect(screen.getByText("1 imported, 1 skipped")).toBeInTheDocument();
  expect(screen.getByText(/Not imported:/)).toHaveTextContent("Brainfuck");
  expect(screen.getByText(/Unsupported template expressions/)).toHaveTextContent("groovyScript");
  expect(set).not.toHaveBeenCalled();
  expect(useLiveTemplates.getState().custom).toBe(before);
  await choose("Cancel", done);
  expect(set).not.toHaveBeenCalled();
  expect(useLiveTemplates.getState().custom).toBe(before);
  expect(localStorage.getItem(LIVE_TEMPLATES_KEY)).toBe(stored);
  expect(notify).not.toHaveBeenCalled();
});

it.each(["/settings/settings.zip", "/settings/PyCharm2026.1"])(
  "confirms and atomically imports visible Python templates from %s, then updates the same ids",
  async (path) => {
    const keep: LiveTemplate = {
      id: "user.keep",
      group: "User",
      abbrev: "keep",
      description: "",
      body: "keep",
      contexts: ["rust"],
    };
    saveTemplate(keep);
    saveTemplate({ ...BUILTIN_TEMPLATES[0]!, body: "my built-in edit" });
    const write = vi.spyOn(Storage.prototype, "setItem");
    render(<MessagesHost />);

    const { done } = await start(path);
    await choose("Import", done);
    expect(read).toHaveBeenCalledExactlyOnceWith(path);
    expect(set).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    const imported = applicableTemplates(useLiveTemplates.getState().templates, "python").find(
      (template) => template.id === "jetbrains.Python.iter",
    );
    expect(imported).toMatchObject({
      group: "Python",
      abbrev: "iter",
      description: "Iterate items",
      body: "for $ITEM$ in $ITEMS$: $END$",
      contexts: ["python"],
      variables: [
        { name: "ITEM", expression: "suggestVariableName()", defaultValue: '"item"', skipIfDefined: true },
        { name: "UNSUPPORTED", expression: 'groovyScript("1")', defaultValue: '"fallback"' },
      ],
    });
    expect(useLiveTemplates.getState().custom.templates[keep.id]).toBe(keep);
    expect(useLiveTemplates.getState().custom.templates[BUILTIN_TEMPLATES[0]!.id]!.body).toBe("my built-in edit");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Settings imported", body: path }));

    read.mockResolvedValue(bundle({ "templates/Python.xml": xml("updated $END$") }));
    const { done: again } = await start(path);
    await choose("Import", again);
    expect(write).toHaveBeenCalledTimes(2);
    expect(
      useLiveTemplates.getState().templates.filter((template) => template.id === "jetbrains.Python.iter"),
    ).toHaveLength(1);
    expect(useLiveTemplates.getState().custom.templates["jetbrains.Python.iter"]!.body).toBe("updated $END$");
    expect(useLiveTemplates.getState().custom.templates[keep.id]).toBe(keep);
  },
);

it("reports malformed template XML without losing existing templates", async () => {
  const existing: LiveTemplate = {
    id: "jetbrains.Python.iter",
    group: "Python",
    abbrev: "iter",
    description: "Existing",
    body: "existing $END$",
    contexts: ["python"],
  };
  saveTemplate(existing);
  const before = useLiveTemplates.getState().custom;
  const write = vi.spyOn(Storage.prototype, "setItem");
  read.mockResolvedValue(bundle({ "templates/Python.xml": "<templateSet>" }));
  render(<MessagesHost />);

  await act(async () => {
    await importJetBrainsSettings("/settings/settings.zip");
  });
  expect(screen.queryByRole("button", { name: "Import" })).not.toBeInTheDocument();
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      level: "warning",
      title: "No settings OpenIDEA can import were found",
      body: "templates/Python.xml",
    }),
  );
  expect(set).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(useLiveTemplates.getState().custom).toBe(before);
  expect(useLiveTemplates.getState().custom.templates[existing.id]).toBe(existing);
});
