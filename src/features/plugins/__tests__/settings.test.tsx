import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { SettingsFormContext, useSettingsPages } from "@/workbench/contributions";
import { useSettingsFormFor } from "@/features/settings/components/context";
import {
  closeSettings,
  openSettings,
  resetPage,
  stagedValue,
  useSettingsDialog,
} from "@/features/settings/model/staging";
import { useProject } from "@/platform/project";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { projectSettings, type SettingsDecl } from "../settings";

const profile = {
  key: "profiles",
  title: "Model profiles",
  type: "array",
  group: "Provider",
  default: [],
  items: {
    key: "item",
    title: "item",
    type: "object",
    default: { name: "Local", enabled: true, limit: 5 },
    properties: [
      { key: "name", title: "Name", type: "string", default: "Local" },
      { key: "enabled", title: "Enabled", type: "boolean", default: true },
      { key: "limit", title: "Token limit", type: "integer", default: 5 },
    ],
  },
} as const;
const declaration: SettingsDecl = {
  title: "Helper",
  properties: [],
  pages: [
    {
      id: "templates",
      title: "Commit Template",
      properties: [
        {
          key: "types",
          title: "Allowed types",
          type: "array",
          default: ["feat", "fix"],
          items: { key: "item", title: "item", type: "string", default: "" },
        },
      ],
    },
    {
      id: "llm",
      title: "LLM Settings",
      properties: [JSON.parse(JSON.stringify(profile))],
      actions: [{ title: "Test", command: "test" }],
    },
  ],
};
let dispose: () => void;
const run = vi.fn(async () => null);
beforeEach(() => {
  useProject.setState({ settings: null, project: null });
  openSettings();
  run.mockReset().mockResolvedValue(null);
  setPluginsBackend({ ...createMemoryPluginsBackend([]), runCommand: run });
  dispose = projectSettings("example.helper", declaration);
});
afterEach(() => {
  dispose();
  closeSettings();
  setPluginsBackend(null);
});

function Harness({
  page,
  apply,
  scope = "global",
}: {
  page: string;
  apply?: () => Promise<boolean>;
  scope?: "global" | "project";
}) {
  const id = `plugins.example-helper.settings:${page}`;
  const form = useSettingsFormFor(id, scope);
  const Component = useSettingsPages.getState().pages.get(id)!.component as ComponentType;
  return (
    <SettingsFormContext.Provider value={apply ? { ...form, apply } : form}>
      <Component />
    </SettingsFormContext.Provider>
  );
}

it("registers searchable child pages and removes all of them on unload", () => {
  const pages = useSettingsPages.getState().pages;
  expect(pages.get("plugins.example-helper")!.component).toBeUndefined();
  const page = pages.get("plugins.example-helper.settings:llm")!;
  expect(page.title).toBe("LLM Settings");
  expect(page.keywords).toEqual(expect.arrayContaining(["Provider", "Name", "Token limit", "Test"]));
  dispose();
  expect([...useSettingsPages.getState().pages.keys()].some((k) => k.startsWith("plugins.example-helper"))).toBe(false);
});

it("stages table edits, keeps changes between pages and discards them on Cancel", () => {
  const view = render(<Harness page="llm" />);
  expect(screen.getByRole("heading", { name: "Provider" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Model profiles: Name 1" }), { target: { value: "Cloud" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Model profiles: Enabled 1" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Model profiles: Token limit 1" }), {
    target: { value: "7.9" },
  });
  expect(useProject.getState().settings).toBeNull();
  view.rerender(<Harness page="templates" />);
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  view.rerender(<Harness page="llm" />);
  expect(screen.getByRole("textbox", { name: "Model profiles: Name 1" })).toHaveValue("Cloud");
  const pending = stagedValue(useSettingsDialog.getState(), "global", "plugins");
  expect(pending).toMatchObject({
    "example.helper": { profiles: [{ name: "Cloud", enabled: false, limit: 7 }], types: ["feat", "fix", ""] },
  });
  act(() => {
    closeSettings();
    openSettings();
  });
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

it("adds, edits, reorders and removes list entries", () => {
  render(<Harness page="templates" />);
  const table = within(screen.getByRole("table", { name: "Allowed types" }));
  fireEvent.click(table.getAllByRole("button", { name: "Move Down" })[0]!);
  expect(table.getAllByRole("textbox")[0]).toHaveValue("fix");
  fireEvent.change(table.getAllByRole("textbox")[0]!, { target: { value: "docs" } });
  fireEvent.click(table.getAllByRole("button", { name: "Move Up" })[1]!);
  expect(table.getAllByRole("textbox")[0]).toHaveValue("feat");
  fireEvent.click(table.getAllByRole("button", { name: "Remove" })[0]!);
  expect(table.getAllByRole("textbox")).toHaveLength(1);
  expect(table.getByRole("textbox")).toHaveValue("docs");
});

it("applies pending values before a command reads them and shows command errors inline", async () => {
  run.mockImplementation(async () => {
    expect(useProject.getState().settings).toMatchObject({
      plugins: { "example.helper": { profiles: [{ name: "Local" }] } },
    });
    throw new Error("Connection refused");
  });
  render(<Harness page="llm" />);
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Test" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Connection refused"));
  expect(run).toHaveBeenCalledWith("example.helper", "test", null, null, [], "global");
  expect(useSettingsDialog.getState().staged).toEqual({});
  act(() => closeSettings());
  expect(useProject.getState().settings).toMatchObject({
    plugins: { "example.helper": { profiles: [{ name: "Local" }] } },
  });
});

it("does not run a command when applying settings fails", async () => {
  render(<Harness page="llm" apply={async () => false} />);
  fireEvent.click(screen.getByRole("button", { name: "Test" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not apply settings."));
  expect(run).not.toHaveBeenCalled();
});

it("preserves the legacy single-schema page", () => {
  const remove = projectSettings("legacy", {
    title: "Legacy",
    properties: [{ key: "enabled", title: "Enabled", type: "boolean", default: true }],
  });
  const Component = useSettingsPages.getState().pages.get("plugins.legacy")!.component!;
  function Legacy() {
    const form = useSettingsFormFor("plugins.legacy", "global");
    return (
      <SettingsFormContext.Provider value={form}>
        <Component />
      </SettingsFormContext.Provider>
    );
  }
  render(<Legacy />);
  expect(screen.getByRole("checkbox", { name: "Enabled" })).toBeChecked();
  remove();
});

it("loads saved plugin settings into the dialog, including dotted plugin ids and keys", () => {
  useProject.setState({
    settings: {
      plugins: { "example.helper": { profiles: [{ name: "Saved", enabled: true, limit: 3 }], "custom.key": ["x"] } },
    } as never,
  });
  openSettings();
  render(<Harness page="llm" />);
  expect(screen.getByRole("textbox", { name: "Model profiles: Name 1" })).toHaveValue("Saved");
});

it.each([{ profiles: [null] }, { profiles: [{}] }, { profiles: [1] }, { profiles: "invalid" }])(
  "falls back from malformed stored tables: %j",
  ({ profiles }) => {
    useProject.setState({ settings: { plugins: { "example.helper": { profiles } } } as never });
    openSettings();
    render(<Harness page="llm" />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
  },
);

it("keeps Reset ownership on each page while merging plugin map writes", () => {
  const view = render(<Harness page="templates" />);
  fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "docs" } });
  view.rerender(<Harness page="llm" />);
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(new Set(Object.values(useSettingsDialog.getState().staged).map((c) => c.page)).size).toBe(2);
  act(() => resetPage("plugins.example-helper.settings:templates"));
  expect(stagedValue(useSettingsDialog.getState(), "global", "plugins")).toMatchObject({
    "example.helper": { profiles: [{ name: "Local" }] },
  });
  expect(
    (stagedValue(useSettingsDialog.getState(), "global", "plugins") as Record<string, Record<string, unknown>>)[
      "example.helper"
    ]!.types,
  ).toBeUndefined();
  act(() => resetPage("plugins.example-helper.settings:llm"));
  expect(useSettingsDialog.getState().staged).toEqual({});
});

it.each(["llm", "templates"])("rejects oversized %s edits without discarding other rows", (page) => {
  render(<Harness page={page} />);
  if (page === "llm") {
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
  }
  const inputs = screen.getAllByRole("textbox");
  const prior = inputs[0]!.getAttribute("value");
  fireEvent.change(inputs[0]!, { target: { value: "é".repeat(32769) } });
  expect(screen.getByRole("alert")).toHaveTextContent("The value exceeds this setting’s limits.");
  expect(inputs[0]).toHaveValue(prior);
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(screen.getAllByRole("row")).toHaveLength(4);
  expect(screen.getAllByRole("textbox")[0]).toHaveValue(prior);
});

it.each(["global", "project"] as const)("passes %s scope to the settings command", async (scope) => {
  render(<Harness page="llm" scope={scope} />);
  fireEvent.click(screen.getByRole("button", { name: "Test" }));
  await waitFor(() => expect(run).toHaveBeenCalledWith("example.helper", "test", null, null, [], scope));
});

it("indexes string-list enum options", () => {
  dispose();
  dispose = projectSettings("example.helper", {
    title: "Helper",
    properties: [],
    pages: [
      {
        id: "list",
        title: "Types",
        properties: [
          {
            key: "types",
            title: "Types",
            type: "array",
            default: [],
            items: {
              key: "item",
              title: "Item",
              type: "string",
              default: "feature",
              options: ["feature", "documentation"],
            },
          },
        ],
      },
    ],
  });
  expect(useSettingsPages.getState().pages.get("plugins.example-helper.settings:list")!.keywords).toContain(
    "documentation",
  );
});
