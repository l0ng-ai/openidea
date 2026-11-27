import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { MessagesHost } from "@/workbench/messages";
import { SettingsFormContext, useSettingsPages } from "@/workbench/contributions";
import { useSettingsFormFor } from "@/features/settings/components/context";
import {
  applySettings,
  closeSettings,
  openSettings,
  resetPage,
  stagedValue,
  useSettingsDialog,
} from "@/features/settings/model/staging";
import { useI18n } from "@/platform/i18n";
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
    {
      id: "defaults",
      title: "Defaults",
      properties: [
        { key: "enabled", title: "Enabled", type: "boolean", default: false },
        { key: "name", title: "Name", type: "string", default: "" },
      ],
    },
    {
      id: "server",
      title: "Server",
      properties: [{ key: "server", title: "Server", type: "string", default: "" }],
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

it("refuses a host value that is not a host when it is staged", async () => {
  const { usePlugins } = await import("../store");
  act(() => {
    usePlugins.setState({
      plugins: [
        {
          id: "example.helper",
          name: "Helper",
          capabilities: [
            { id: "net:setting:server", risk: "medium", description: "Connect", optional: true, granted: true },
          ],
        } as never,
      ],
    });
  });
  render(<Harness page="server" />);
  const field = screen.getByRole("textbox", { name: "Server" });
  fireEvent.change(field, { target: { value: "not a host!" } });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Enter a host/));
  expect(stagedValue(useSettingsDialog.getState(), "global", "plugins")).toEqual({});
  fireEvent.change(field, { target: { value: "jira.corp.example" } });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(stagedValue(useSettingsDialog.getState(), "global", "plugins")).toMatchObject({
    "example.helper": { server: "jira.corp.example" },
  });
});

it("asks about the host when a net:setting value is applied; deny leaves it unapproved", async () => {
  const user = userEvent.setup();
  const approveNetSetting = vi.fn(async () => ({}) as never);
  setPluginsBackend({ ...createMemoryPluginsBackend([]), approveNetSetting });
  const { usePlugins } = await import("../store");
  const plugin = {
    id: "example.helper",
    name: "Helper",
    version: "1.0.0",
    description: "",
    authors: [],
    homepage: null,
    changeNotes: null,
    icon: null,
    javaAgent: null,
    source: "installed",
    path: "/plugins/helper",
    enabled: true,
    status: "active",
    error: null,
    hasCode: true,
    capabilities: [{ id: "net:setting:server", risk: "medium", description: "Connect", optional: true, granted: true }],
    netHosts: [],
    netSettings: [],
    contributions: [],
    activation: [],
    warnings: [],
    stats: {
      activations: 0,
      activationMs: 0,
      calls: 0,
      errors: 0,
      maxCallMs: 0,
      p95CallMs: 0,
      slowCalls: 0,
      crashes: 0,
      reclaims: 0,
    },
    publisher: null,
    previousVersion: null,
    depends: [],
    dependents: [],
    extensionPoints: [],
  };
  act(() => {
    usePlugins.setState({ plugins: [plugin as never] });
  });
  render(
    <>
      <MessagesHost />
      <Harness page="server" />
    </>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Server" }), {
    target: { value: "https://jira.corp.example/" },
  });
  await waitFor(() =>
    expect(stagedValue(useSettingsDialog.getState(), "global", "plugins")).toMatchObject({
      "example.helper": { server: "https://jira.corp.example/" },
    }),
  );
  // Applying asks; the answer resolves the apply.
  const applying = applySettings();
  await user.click(await screen.findByRole("button", { name: "Deny" }));
  await act(() => applying);
  await waitFor(() => expect(approveNetSetting).not.toHaveBeenCalled());
  // The value itself was saved; only the approval was withheld.
  expect(useProject.getState().settings).toMatchObject({
    plugins: { "example.helper": { server: "https://jira.corp.example/" } },
  });
});

it("records the approval when the applied host is allowed, and forgets it when cleared", async () => {
  const user = userEvent.setup();
  const approveNetSetting = vi.fn(async () => ({}) as never);
  const forgetNetSetting = vi.fn(async () => ({}) as never);
  setPluginsBackend({ ...createMemoryPluginsBackend([]), approveNetSetting, forgetNetSetting });
  const { usePlugins } = await import("../store");
  const plugin = {
    id: "example.helper",
    name: "Helper",
    netSettings: [],
    capabilities: [{ id: "net:setting:server", risk: "medium", description: "Connect", optional: true, granted: true }],
  };
  act(() => {
    usePlugins.setState({ plugins: [plugin as never] });
  });
  render(
    <>
      <MessagesHost />
      <Harness page="server" />
    </>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Server" }), { target: { value: "jira.corp.example" } });
  await waitFor(() =>
    expect(stagedValue(useSettingsDialog.getState(), "global", "plugins")).toMatchObject({
      "example.helper": { server: "jira.corp.example" },
    }),
  );
  const applying = applySettings();
  await user.click(await screen.findByRole("button", { name: "Allow" }));
  await act(() => applying);
  await waitFor(() =>
    expect(approveNetSetting).toHaveBeenCalledWith("example.helper", "server", false, "jira.corp.example"),
  );

  // Clearing the value forgets the approval without a dialog.
  fireEvent.change(screen.getByRole("textbox", { name: "Server" }), { target: { value: "" } });
  await waitFor(() =>
    expect(stagedValue(useSettingsDialog.getState(), "global", "plugins")).toMatchObject({
      "example.helper": { server: "" },
    }),
  );
  await act(() => applySettings());
  await waitFor(() => expect(forgetNetSetting).toHaveBeenCalledWith("example.helper", "server", false));
  expect(screen.queryByText(/Allow Helper to connect/)).toBeNull();
});

it("lists the plugin's declared secrets on its settings page", async () => {
  setPluginsBackend({
    ...createMemoryPluginsBackend([]),
    list: async () => ({
      plugins: [{ id: "example.helper" } as never],
      activeTheme: null,
      ui: [
        { pluginId: "example.helper", point: "secrets", key: "api-key", decl: { name: "api-key", label: "API key" } },
      ],
    }),
  });
  const { refreshPlugins } = await import("../store");
  await refreshPlugins();
  render(<Harness page="llm" />);
  expect(screen.getByRole("heading", { name: "Secrets" })).toBeInTheDocument();
  expect(await screen.findByLabelText("Value of API key")).toBeInTheDocument();
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

it("keeps values that equal the setting's default instead of dropping them", () => {
  useProject.setState({
    settings: { plugins: { "example.helper": { enabled: true, name: "Custom" } } } as never,
  });
  openSettings();
  render(<Harness page="defaults" />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Enabled" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "" } });
  expect(stagedValue(useSettingsDialog.getState(), "global", "plugins")).toMatchObject({
    "example.helper": { enabled: false, name: "" },
  });
});

it("shows the plugin's setting titles as the plugin wrote them, keeping the IDE's own words translated", () => {
  const previous = useI18n.getState().texts;
  useI18n.setState({ texts: { ...previous, Enabled: "已启用", "Move Up": "上移" } });
  try {
    render(<Harness page="defaults" />);
    expect(screen.getByRole("checkbox", { name: "Enabled" })).toBeInTheDocument();
    expect(screen.queryByText("已启用")).not.toBeInTheDocument();
  } finally {
    useI18n.setState({ texts: previous });
  }
});
