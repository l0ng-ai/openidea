import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { provideNotificationService, type NotificationService } from "@/workbench/contributions";
import { useTasks } from "@/workbench/tasks";
import { MemoryToolsBackend, sampleTools, setToolsBackend } from "../backend";
import { cancelInstall, installTool, refreshTools, uninstallTool, useTools } from "../store";
import { filterTools, LanguageServersPage } from "../LanguageServersPage";
import { installMissingServerPrompts, missingKey } from "../missing";
import { resetTestForm, stagedFor, TestSettingsForm } from "./settingsForm";

type Note = Parameters<NotificationService["notify"]>[0];
let notes: Note[];
let backend: MemoryToolsBackend;

beforeEach(() => {
  notes = [];
  provideNotificationService({ notify: (n) => void notes.push(n) });
  backend = new MemoryToolsBackend(sampleTools(), 1);
  setToolsBackend(backend);
  useTools.setState({ tools: [], loaded: false, loading: false, error: null, jobs: {}, logs: {} });
});

afterEach(() => setToolsBackend(null));

describe("tools store", () => {
  it("installs, streams progress, restarts servers and notifies", async () => {
    await refreshTools();
    const seen: Array<number | null> = [];
    const unsub = useTools.subscribe((s) => {
      const j = s.jobs["gopls"];
      if (j) seen.push(j.fraction);
    });
    const info = await installTool("gopls");
    unsub();
    expect(info?.status).toBe("installed");
    expect(seen).toContain(0.5);
    expect(useTools.getState().jobs["gopls"]).toBeUndefined();
    expect(useTools.getState().logs["gopls"]?.lines.at(-1)).toContain("installed");
    expect(backend.restarted).toEqual(["gopls"]);
    expect(notes.at(-1)).toMatchObject({ level: "info", title: "gopls installed" });
    expect(useTasks.getState().tasks.find((t) => t.id === "tools:gopls")?.done ?? true).toBe(true);
  });

  it("deduplicates concurrent installs of one tool", async () => {
    await refreshTools();
    const a = installTool("vtsls");
    const b = installTool("vtsls");
    expect(a).toBe(b);
    await a;
  });

  it("reports failures with a details action", async () => {
    await refreshTools();
    backend.failNext = "gopls";
    expect(await installTool("gopls")).toBeNull();
    expect(notes.at(-1)).toMatchObject({ level: "error", title: "Failed to install gopls" });
    expect(notes.at(-1)?.actions?.[0]?.label).toBe("Show details");
    expect(useTools.getState().logs["gopls"]?.error).toContain("failed");
  });

  it("cancels quietly", async () => {
    backend.stepMs = 20;
    await refreshTools();
    const p = installTool("gopls");
    cancelInstall("gopls");
    expect(await p).toBeNull();
    expect(notes.filter((n) => n.level === "error")).toHaveLength(0);
    expect(useTools.getState().tools.find((t) => t.name === "gopls")?.status).toBe("missing");
  });

  it("installs one at a time; one cancelled while it waits never starts", async () => {
    backend.stepMs = 10;
    await refreshTools();
    const install = vi.spyOn(backend, "install");
    const first = installTool("gopls");
    const queued = installTool("vtsls");
    expect(useTasks.getState().tasks.find((t) => t.id === "tools:vtsls")).toMatchObject({ queued: true });
    cancelInstall("vtsls");
    expect(useTasks.getState().tasks.find((t) => t.id === "tools:vtsls")).toBeUndefined();
    expect(await queued).toBeNull();
    expect(useTools.getState().logs["vtsls"]?.error).toBe("Cancelled");
    expect((await first)?.status).toBe("installed");
    expect(install.mock.calls.map((c) => c[0])).toEqual(["gopls"]);
    expect(notes.filter((n) => n.level === "error")).toHaveLength(0);
  });

  it("uninstalls", async () => {
    await refreshTools();
    expect(await uninstallTool("rust-analyzer")).toBe(true);
    expect(useTools.getState().tools.find((t) => t.name === "rust-analyzer")?.status).toBe("missing");
  });

  it("filters by text and status", () => {
    const tools = sampleTools();
    expect(filterTools(tools, "go", "all").map((t) => t.name)).toEqual(["gopls", "delve"]);
    expect(filterTools(tools, "", "installed").map((t) => t.name)).toEqual([
      "rust-analyzer",
      "typescript-language-server",
    ]);
    expect(filterTools(tools, "kotlin", "missing").map((t) => t.name)).toEqual(["kotlin-lsp"]);
  });
});

describe("missing language server prompt", () => {
  it("offers Install for installable servers, once, replacing the generic notice", async () => {
    const off = installMissingServerPrompts();
    const ev = { type: "languageServer", server: 1, name: "gopls", status: "missing", message: null } as const;
    emitLocalIdeEvent(ev);
    emitLocalIdeEvent(ev);
    await waitFor(() => expect(notes).toHaveLength(1));
    const n = notes[0]!;
    expect(n.title).toBe("gopls is not installed");
    expect(n.key).toBe(missingKey("gopls"));
    n.actions![0]!.run();
    await waitFor(() => expect(backend.restarted).toEqual(["gopls"]));
    await waitFor(() => expect(notes.at(-1)).toMatchObject({ title: "gopls installed", key: missingKey("gopls") }));
    off();
  });

  it("stays silent when an installed alternative serves the same languages", async () => {
    const off = installMissingServerPrompts();
    // typescript-language-server (on PATH) covers vtsls' languages.
    emitLocalIdeEvent({ type: "languageServer", server: 4, name: "vtsls", status: "missing", message: null });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(notes).toHaveLength(0);
    off();
  });

  it("stays silent for tools without an installer", async () => {
    const off = installMissingServerPrompts();
    emitLocalIdeEvent({ type: "languageServer", server: 2, name: "solargraph", status: "missing", message: null });
    emitLocalIdeEvent({ type: "languageServer", server: 3, name: "rust-analyzer", status: "ready", message: null });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(notes).toHaveLength(0);
    off();
  });
});

describe("LanguageServersPage", () => {
  beforeEach(() => resetTestForm());
  const renderPage = () =>
    render(
      <TestSettingsForm>
        <LanguageServersPage />
      </TestSettingsForm>,
    );
  const listItem = (name: string) =>
    screen.getByRole("list", { name: /language servers/i }).querySelector<HTMLElement>(`[data-tool="${name}"]`)!;

  it("lists tools and installs from the details pane", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("gopls");
    await user.click(listItem("gopls"));
    const details = screen.getByLabelText("gopls details");
    expect(within(details).getByText("Missing")).toBeInTheDocument();
    await user.click(within(details).getByRole("button", { name: "Install gopls" }));
    await waitFor(() => expect(screen.getByLabelText("gopls details")).toHaveTextContent("Installed"));
    expect(screen.getByLabelText("gopls details")).toHaveTextContent("1.0.0");
    // Installed tools move to the Available group, still selected.
    expect(listItem("gopls")).toHaveAttribute("aria-current", "true");
    // The install log can be shown afterwards.
    await user.click(screen.getByRole("button", { name: "Show install log" }));
    expect(screen.getByLabelText("gopls install log")).toHaveTextContent("Installing gopls");
  });

  it("explains why a tool cannot be installed", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("solargraph");
    await user.click(listItem("solargraph"));
    expect(screen.getByText("gem install solargraph")).toBeInTheDocument();
    await user.click(listItem("zls"));
    expect(screen.getByText("curl is required to download tools")).toBeInTheDocument();
  });

  it("stages and clears a custom path", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("gopls");
    await user.click(listItem("gopls"));
    const path = within(screen.getByLabelText("gopls details")).getByRole("textbox", { name: "Path" });
    await user.type(path, "/opt/go/bin/gopls");
    expect(stagedFor("tools.gopls.path")).toBe("/opt/go/bin/gopls");
    await user.clear(path);
    expect(stagedFor("tools.gopls.path")).toBeNull();
    // Picked with the file chooser.
    backend.chosen = "/usr/local/bin/gopls";
    await user.click(within(screen.getByLabelText("gopls details")).getByRole("button", { name: "Browse…" }));
    expect(stagedFor("tools.gopls.path")).toBe("/usr/local/bin/gopls");
    expect(path).toHaveValue("/usr/local/bin/gopls");
  });

  it("moves the selection with the arrow keys", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("gopls");
    await user.click(listItem("rust-analyzer"));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByLabelText("typescript-language-server details")).toBeInTheDocument();
  });

  it("filters to missing tools", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("gopls");
    await user.click(screen.getByRole("radio", { name: /missing/i }));
    expect(screen.queryByText("rust-analyzer")).not.toBeInTheDocument();
    expect(screen.getByText("gopls")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /filter language servers/i }), "zig");
    expect(screen.queryByText("gopls")).not.toBeInTheDocument();
    expect(listItem("zls")).toHaveTextContent("ZLS (Zig)");
  });

  it("shows backend errors", async () => {
    vi.spyOn(backend, "list").mockRejectedValueOnce(new Error("boom"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});

describe("tools.install action", () => {
  it("installs installable tools and opens the page for the rest", async () => {
    const { executeAction, registerAction } = await import("@/platform/actions");
    const { activate } = await import("../index");
    const opened: unknown[] = [];
    const disposers = [
      registerAction({ id: "file.settings", title: "Settings", run: ({ arg }) => void opened.push(arg) }),
      activate(),
    ];
    try {
      await executeAction("tools.install", "gopls");
      expect(useTools.getState().tools.find((t) => t.name === "gopls")?.status).toBe("installed");
      expect(opened).toEqual([]);
      await executeAction("tools.install", "solargraph");
      expect(opened).toEqual(["languages.servers"]);
    } finally {
      disposers.reverse().forEach((d) => d());
    }
  });
});
