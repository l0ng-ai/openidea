import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentProvider, AgentRegistry, InstallEvent, RegistryAgent, RequestId } from "@/bindings";
import { IpcError } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { MessagesHost } from "@/workbench/messages";
import { AgentRegistryPage } from "./AgentRegistryPage";
import { ADD_AGENT, providerOptions } from "./providerOptions";
import { afterRemove, matchesQuery, rowActions, sortAgents, type RegistryBackend } from "./registry";

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
