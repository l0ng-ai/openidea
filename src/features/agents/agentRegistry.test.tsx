import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentProvider, AgentRegistry, InstallEvent, RegistryAgent, RequestId } from "@/bindings";
import { IpcError } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { MessagesHost } from "@/workbench/messages";
import { AgentRegistryPage as RegistryPage } from "./AgentRegistryPage";
import { SettingsFormContext, registerSettingsPage } from "@/workbench/contributions";
import { useSettingsFormFor } from "@/features/settings/components/context";
import { closeSettings, openSettings, selectPage } from "@/features/settings/model/staging";
import { SettingsDialog } from "@/features/settings/dialog/SettingsDialog";
import { REGISTRY_PAGE } from "./model";
import type { ComponentProps } from "react";

function AgentRegistryPage(props: ComponentProps<typeof RegistryPage>) {
  const form = useSettingsFormFor(REGISTRY_PAGE, "global");
  return (
    <SettingsFormContext.Provider value={form}>
      <RegistryPage {...props} />
    </SettingsFormContext.Provider>
  );
}
import { ADD_AGENT, providerOptions } from "./providerOptions";
import {
  afterRemove,
  matchesQuery,
  rowActions,
  sortAgents,
  type CommandsBackend,
  type RegistryBackend,
} from "./registry";

const agent = (partial: Partial<RegistryAgent> & Pick<RegistryAgent, "id" | "name">): RegistryAgent => ({
  version: "1.0.0",
  description: "",
  repository: null,
  website: null,
  authors: [],
  license: null,
  distribution: "npx",
  noChecksum: false,
  installed: null,
  update: false,
  ...partial,
});

const AMP = agent({
  id: "amp-acp",
  name: "Amp",
  version: "0.10.0",
  description: "The frontier coding agent",
  repository: "https://github.com/x/amp-acp",
  authors: ["Sourcegraph"],
  distribution: "binary",
});
const CLINE = agent({ id: "cline", name: "Cline", version: "3.0.74", installed: "3.0.70", update: true });
const FAST = agent({
  id: "fast-agent",
  name: "fast-agent",
  version: "0.10.1",
  distribution: "uvx",
  installed: "0.10.1",
});
const AGENTS: RegistryAgent[] = [AMP, CLINE, FAST];

class FakeBackend implements RegistryBackend {
  registry: AgentRegistry = { agents: AGENTS, warning: null };
  installs: string[] = [];
  removed: string[] = [];
  cancelled: RequestId[] = [];
  finish: () => void = () => {};
  fail: (e: unknown) => void = () => {};
  emit: (e: InstallEvent) => void = () => {};
  list = vi.fn(async () => this.registry);
  install(id: string, _request: RequestId, onEvent: (e: InstallEvent) => void) {
    this.installs.push(id);
    this.emit = onEvent;
    return new Promise<void>((resolve, reject) => {
      this.finish = resolve;
      this.fail = reject;
    });
  }
  async remove(id: string) {
    this.removed.push(id);
  }
  cancel(request: RequestId) {
    this.cancelled.push(request);
  }
}

const row = (name: string) => screen.getByRole("listitem", { name });

describe("registry helpers", () => {
  it("matches every word of the query against name, id, description and authors", () => {
    expect(matchesQuery(AMP, "frontier sourcegraph")).toBe(true);
    expect(matchesQuery(AMP, "amp-acp")).toBe(true);
    expect(matchesQuery(AMP, "cline")).toBe(false);
    expect(matchesQuery(AMP, "  ")).toBe(true);
  });

  it("offers install, update and remove by state", () => {
    expect(rowActions(AMP)).toEqual({ install: true, update: false, remove: false });
    expect(rowActions(CLINE)).toEqual({ install: false, update: true, remove: true });
    expect(rowActions(FAST)).toEqual({ install: false, update: false, remove: true });
    // Installed, but nothing to run it with any more: only Remove.
    expect(rowActions({ ...CLINE, distribution: null })).toEqual({ install: false, update: false, remove: true });
  });

  it("lists installed agents, then well-known ones, then the rest by name", () => {
    const named = (id: string, name: string, installed: string | null = null): RegistryAgent => ({
      ...AMP,
      id,
      name,
      installed,
    });
    const sorted = sortAgents([
      named("agoragentic-acp", "Agoragentic"),
      named("zed", "Zed"),
      named("cline", "Cline"),
      named("amp-acp", "Amp"),
      named("bob", "Bob", "2.0.9"),
    ]);
    expect(sorted.map((a) => a.name)).toEqual(["Bob", "Amp", "Cline", "Agoragentic", "Zed"]);
  });

  it("drops a removed agent this system cannot install again", () => {
    const gone = afterRemove([{ ...FAST, distribution: null }], "fast-agent");
    expect(gone).toEqual([]);
    expect(afterRemove(AGENTS, "cline").find((a) => a.id === "cline")?.installed).toBeNull();
  });
});

describe("agent picker", () => {
  const provider = (p: Partial<AgentProvider> & Pick<AgentProvider, "id" | "source">): AgentProvider => ({
    name: p.id,
    command: p.id,
    installed: true,
    config: [],
    commands: [],
    ...p,
  });

  it("shows registry versions and updates, then Add Agent…", () => {
    const options = providerOptions(
      [
        provider({ id: "claude", source: { kind: "builtin" } }),
        provider({ id: "amp-acp", source: { kind: "registry", version: "0.9.0", update: "0.10.0" } }),
        provider({ id: "cline", source: { kind: "registry", version: "3.0.74", update: null } }),
        provider({ id: "gemini", installed: false, source: { kind: "builtin" } }),
      ],
      tx,
      () => "toolwindow-agents",
    );
    expect(options.map((o) => [o.value, o.detail])).toEqual([
      ["claude", undefined],
      ["amp-acp", "0.10.0 available"],
      ["cline", "3.0.74"],
      ["__missing__", undefined],
      ["gemini", "gemini"],
      [ADD_AGENT, undefined],
    ]);
  });
});

describe("Agents settings page", () => {
  it("lists registry agents, says they are third-party, and searches them", async () => {
    const backend = new FakeBackend();
    render(<AgentRegistryPage backend={backend} />);
    await waitFor(() => expect(row("Amp")).toBeInTheDocument());
    expect(screen.getByText(/third-party software/)).toBeInTheDocument();
    expect(within(row("Amp")).getByRole("button", { name: "Install" })).toBeEnabled();
    expect(within(row("Amp")).getByRole("button", { name: "Repository" })).toBeInTheDocument();
    expect(within(row("Cline")).getByText("3.0.74 available")).toBeInTheDocument();
    expect(within(row("Cline")).getByRole("button", { name: "Update" })).toBeInTheDocument();
    expect(within(row("fast-agent")).getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(within(row("fast-agent")).queryByRole("button", { name: "Update" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Search agents" }), { target: { value: "frontier" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Search agents" }), { target: { value: "nothing" } });
    expect(screen.getByText("No agents match")).toBeInTheDocument();
  });

  it("installs with progress, then reports the change", async () => {
    const backend = new FakeBackend();
    const onChanged = vi.fn();
    render(<AgentRegistryPage onChanged={onChanged} backend={backend} />);
    await waitFor(() => expect(row("Amp")).toBeInTheDocument());
    fireEvent.click(within(row("Amp")).getByRole("button", { name: "Install" }));
    expect(backend.installs).toEqual(["amp-acp"]);
    act(() => backend.emit({ type: "progress", fraction: 0.5, message: "Downloaded 1.0 of 2.0 MB" }));
    expect(within(row("Amp")).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(within(row("Amp")).getByText("Downloaded 1.0 of 2.0 MB")).toBeInTheDocument();
    // One install at a time.
    expect(within(row("Cline")).getByRole("button", { name: "Update" })).toBeDisabled();

    await act(async () => backend.finish());
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(within(row("Amp")).getByText("Installed")).toBeInTheDocument();
    expect(within(row("Amp")).getByRole("button", { name: "Remove" })).toBeEnabled();
  });

  it("asks before installing an agent whose download has no checksum", async () => {
    const backend = new FakeBackend();
    backend.registry = { agents: [{ ...AMP, noChecksum: true }], warning: null };
    render(
      <>
        <AgentRegistryPage backend={backend} />
        <MessagesHost />
      </>,
    );
    await waitFor(() => expect(row("Amp")).toBeInTheDocument());
    expect(within(row("Amp")).getByText("No checksum provided")).toBeInTheDocument();

    fireEvent.click(within(row("Amp")).getByRole("button", { name: "Install" }));
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Amp provides no checksum for its download");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(backend.installs).toEqual([]);

    fireEvent.click(within(row("Amp")).getByRole("button", { name: "Install" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(backend.installs).toEqual(["amp-acp"]));
  });

  it("installs an agent with a checksum without asking", async () => {
    const backend = new FakeBackend();
    render(
      <>
        <AgentRegistryPage backend={backend} />
        <MessagesHost />
      </>,
    );
    await waitFor(() => expect(row("Amp")).toBeInTheDocument());
    expect(screen.queryByText("No checksum provided")).toBeNull();
    fireEvent.click(within(row("Amp")).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(backend.installs).toEqual(["amp-acp"]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows why an install failed, and cancels one when the page closes", async () => {
    const backend = new FakeBackend();
    const { unmount } = render(<AgentRegistryPage backend={backend} />);
    await waitFor(() => expect(row("Cline")).toBeInTheDocument());
    fireEvent.click(within(row("Cline")).getByRole("button", { name: "Update" }));
    await act(async () => backend.fail(new IpcError({ kind: "unavailable", message: "npm is required" })));
    expect(within(row("Cline")).getByRole("alert")).toHaveTextContent("npm is required");

    fireEvent.click(within(row("Amp")).getByRole("button", { name: "Install" }));
    fireEvent.click(within(row("Amp")).getByRole("button", { name: "Cancel" }));
    expect(backend.cancelled).toHaveLength(1);
    // Leaving the page stops an install still running.
    const install = backend.cancelled[0];
    unmount();
    expect(backend.cancelled.filter((r) => r === install)).toHaveLength(2);
  });

  it("removes an installed agent", async () => {
    const backend = new FakeBackend();
    const onChanged = vi.fn();
    render(<AgentRegistryPage onChanged={onChanged} backend={backend} />);
    await waitFor(() => expect(row("fast-agent")).toBeInTheDocument());
    fireEvent.click(within(row("fast-agent")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(row("fast-agent")).getByRole("button", { name: "Install" })).toBeEnabled());
    expect(backend.removed).toEqual(["fast-agent"]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("falls back to the saved list with a warning, and reports a registry it cannot load", async () => {
    const backend = new FakeBackend();
    backend.registry = { agents: AGENTS, warning: "Could not reach the ACP Registry" };
    const { unmount } = render(<AgentRegistryPage backend={backend} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not reach the ACP Registry"));
    unmount();

    backend.list.mockRejectedValueOnce(new IpcError({ kind: "io", message: "offline" }));
    render(<AgentRegistryPage backend={backend} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Cannot load the ACP Registry: offline"));
  });
});

class FakeCommands implements CommandsBackend {
  list: AgentProvider[] = [];
  saved: [string, string | null][] = [];
  providers = vi.fn(async () => this.list);
  async set(id: string, command: string | null) {
    this.saved.push([id, command]);
    // What the agent list shows after the override takes effect.
    this.list = this.list.map((p) => (p.id === id ? { ...p, command: command ?? p.id } : p));
  }
}

const claudeProvider = (command: string): AgentProvider => ({
  id: "claude",
  name: "Claude Code",
  command,
  installed: true,
  config: [],
  commands: [],
  source: { kind: "builtin" },
});

describe("Claude Code command override", () => {
  let dispose = () => {};
  beforeEach(() => openSettings(REGISTRY_PAGE));
  afterEach(() => {
    closeSettings();
    dispose();
  });

  const openCommands = async (commands: FakeCommands, onChanged = vi.fn()) => {
    const backend = new FakeBackend();
    dispose = registerSettingsPage({
      id: REGISTRY_PAGE,
      title: "Agents",
      group: "Tools",
      component: () => <RegistryPage backend={backend} commandBackend={commands} onChanged={onChanged} />,
    });
    render(<SettingsDialog />);
    return screen.findByRole("region", { name: "Claude Code command" });
  };
  const apply = () => screen.getByRole("button", { name: "Apply" });
  const field = () => screen.getByRole("textbox", { name: "Claude Code command" });

  it("is hidden when providers cannot be read (no trusted project)", async () => {
    const commands = new FakeCommands();
    commands.providers.mockRejectedValue(new IpcError({ kind: "unavailable", message: "restricted" }));
    render(<AgentRegistryPage backend={new FakeBackend()} commandBackend={commands} />);
    await waitFor(() => expect(row("Amp")).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Claude Code command" })).toBeNull();
  });

  it.each(["Apply", "OK"])("stages a binary path and writes it only on %s", async (button) => {
    const commands = new FakeCommands();
    commands.list = [claudeProvider("claude")];
    const onChanged = vi.fn();
    const section = await openCommands(commands, onChanged);
    expect(apply()).toBeDisabled();
    expect(field()).toHaveValue("claude");
    expect(within(section).queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.change(field(), { target: { value: "D:\\tools\\claude.exe" } });
    expect(commands.saved).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
    expect(apply()).toBeEnabled();
    expect(within(section).queryByText("Custom command")).toBeNull();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: button })));
    expect(commands.saved).toEqual([["claude", "D:\\tools\\claude.exe"]]);
    expect(onChanged).toHaveBeenCalledOnce();
    if (button === "Apply") {
      expect(within(section).getByText("Custom command")).toBeInTheDocument();
      expect(apply()).toBeDisabled();
    } else expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Cancel discards command edits without writing", async () => {
    const commands = new FakeCommands();
    commands.list = [claudeProvider("/saved/claude")];
    await openCommands(commands);
    fireEvent.change(field(), { target: { value: "/unsaved/claude" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(commands.saved).toEqual([]);
    act(() => openSettings(REGISTRY_PAGE));
    expect(await screen.findByRole("textbox", { name: "Claude Code command" })).toHaveValue("/saved/claude");
    expect(apply()).toBeDisabled();
  });

  it.each(["clear", "Reset"])("%s stages automatic detection until Apply", async (action) => {
    const commands = new FakeCommands();
    commands.list = [claudeProvider("/saved/claude")];
    const section = await openCommands(commands);
    if (action === "clear") fireEvent.change(field(), { target: { value: "" } });
    else fireEvent.click(within(section).getByRole("button", { name: "Reset" }));
    expect(field()).toHaveValue("");
    expect(commands.saved).toEqual([]);
    expect(within(section).getByText("Custom command")).toBeInTheDocument();
    expect(apply()).toBeEnabled();
    await act(async () => fireEvent.click(apply()));
    expect(commands.saved).toEqual([["claude", null]]);
    expect(field()).toHaveValue("claude");
    expect(within(section).queryByText("Custom command")).toBeNull();
    expect(apply()).toBeDisabled();
  });

  it("page Reset discards edits and returning to the saved value clears the modified state", async () => {
    const commands = new FakeCommands();
    commands.list = [claudeProvider("/saved/claude")];
    await openCommands(commands);
    fireEvent.change(field(), { target: { value: "/edited/claude" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reset" })[0]!);
    expect(field()).toHaveValue("/saved/claude");
    expect(apply()).toBeDisabled();
    fireEvent.change(field(), { target: { value: "/edited/claude" } });
    fireEvent.change(field(), { target: { value: "/saved/claude" } });
    expect(apply()).toBeDisabled();
    expect(commands.saved).toEqual([]);
  });

  it.each([false, true])("keeps edits across page navigation and applies with Agents mounted=%s", async (mounted) => {
    const commands = new FakeCommands();
    commands.list = [claudeProvider("claude")];
    await openCommands(commands);
    const off = registerSettingsPage({ id: "other", title: "Other" });
    try {
      fireEvent.change(field(), { target: { value: "/custom/claude" } });
      act(() => selectPage("other"));
      expect(apply()).toBeEnabled();
      if (mounted) {
        act(() => selectPage(REGISTRY_PAGE));
        expect(await screen.findByRole("textbox", { name: "Claude Code command" })).toHaveValue("/custom/claude");
      }
      await act(async () => fireEvent.click(apply()));
      act(() => selectPage(REGISTRY_PAGE));
      expect(await screen.findByRole("textbox", { name: "Claude Code command" })).toHaveValue("/custom/claude");
      expect(screen.getByText("Custom command")).toBeInTheDocument();
      expect(commands.saved).toEqual([["claude", "/custom/claude"]]);
      expect(apply()).toBeDisabled();
    } finally {
      off();
    }
  });

  it("retains a failed command for retry and shows only the applied badge", async () => {
    const commands = new FakeCommands();
    commands.list = [claudeProvider("claude")];
    const set = vi.spyOn(commands, "set").mockRejectedValueOnce(new Error("Read-only configuration"));
    const section = await openCommands(commands);
    fireEvent.change(field(), { target: { value: " /custom/claude " } });
    await act(async () => fireEvent.click(apply()));
    expect(screen.getByRole("status")).toHaveTextContent("Read-only configuration");
    expect(field()).toHaveValue(" /custom/claude ");
    expect(within(section).queryByText("Custom command")).toBeNull();
    expect(apply()).toBeEnabled();
    await act(async () => fireEvent.click(apply()));
    expect(set).toHaveBeenCalledTimes(2);
    expect(commands.saved).toEqual([["claude", "/custom/claude"]]);
    expect(field()).toHaveValue("/custom/claude");
    expect(within(section).getByText("Custom command")).toBeInTheDocument();
  });
});
