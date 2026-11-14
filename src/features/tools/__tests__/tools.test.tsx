import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { provideNotificationService, type NotificationService } from "@/workbench/contributions";
import { useTasks } from "@/workbench/tasks";
import { MemoryToolsBackend, sampleTools, setToolsBackend } from "../backend";
import { cancelInstall, installTool, refreshTools, uninstallTool, useTools } from "../store";
import { filterLanguages, groupByLanguage, LanguageServersPage } from "../LanguageServersPage";
import { installMissingServerPrompts, installServerWarningPrompts, missingKey, promptInstall } from "../missing";
import { resetTestForm, stagedFor, TestSettingsForm } from "./settingsForm";

type Note = Parameters<NotificationService["notify"]>[0];
let notes: Note[];
let backend: MemoryToolsBackend;

beforeEach(() => {
  notes = [];
  provideNotificationService({ notify: (n) => void notes.push(n) });
  backend = new MemoryToolsBackend(sampleTools(), 1);
  setToolsBackend(backend);
  useTools.setState({
    tools: [],
    loaded: false,
    loading: false,
    error: null,
    jobs: {},
    logs: {},
    updates: {},
    checkingUpdates: false,
    updatesChecked: false,
  });
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
    expect(notes.at(-1)).toMatchObject({
      level: "info",
      title: "gopls installed",
    });
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
    expect(notes.at(-1)).toMatchObject({
      level: "error",
      title: "Failed to install gopls",
    });
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

  it("groups tools by language and filters by text and missing tools", () => {
    const langs = groupByLanguage(sampleTools());
    expect(langs.map((l) => l.name)).toEqual([
      "C",
      "C++",
      "Go",
      "JavaScript",
      "Kotlin",
      "Python",
      "Ruby",
      "Rust",
      "TypeScript",
      "Zig",
    ]);
    const go = langs.find((l) => l.name === "Go")!;
    expect(go.tools.map((t) => t.name)).toEqual(["gopls", "delve"]);
    expect(go.state).toBe("none");
    expect(go.missing.map((t) => t.name)).toEqual(["gopls", "delve"]);
    // One installed server is enough; the missing alternative isn't offered.
    expect(langs.find((l) => l.name === "TypeScript")).toMatchObject({
      state: "ready",
      missing: [],
    });
    // Rust has its server; only the debugger is missing.
    expect(langs.find((l) => l.name === "Rust")!.missing.map((t) => t.name)).toEqual(["codelldb"]);
    // The first installable of interchangeable servers.
    expect(langs.find((l) => l.name === "Python")!.missing.map((t) => t.name)).toEqual(["basedpyright"]);

    expect(filterLanguages(langs, "dlv", false).map((l) => l.name)).toEqual(["Go"]);
    expect(filterLanguages(langs, "codelldb", false).map((l) => l.name)).toEqual(["C", "C++", "Rust"]);
    expect(filterLanguages(langs, "", true).map((l) => l.name)).not.toContain("TypeScript");
  });

  it("lists tools serving no language under Other Tools, last", () => {
    const cli = {
      ...sampleTools()[0]!,
      name: "devcontainer",
      kind: "cli" as const,
      languages: [],
    };
    expect(groupByLanguage([cli, ...sampleTools()]).at(-1)).toMatchObject({
      name: "Other Tools",
    });
  });
});

describe("missing language server prompt", () => {
  it("uses the same install prompt for Prettier with a Reformat Code explanation", async () => {
    const template = sampleTools()[0]!;
    backend.tools.push({
      ...template,
      name: "prettier",
      displayName: "Prettier",
      command: "prettier",
      kind: "formatter",
      status: "missing",
      installMethod: "npm",
      languages: ["Markdown"],
    });
    await promptInstall("prettier");
    expect(notes[0]).toMatchObject({
      title: "Prettier is not installed",
      key: missingKey("prettier"),
      sticky: true,
      body: "Reformat Code needs Prettier. Install it via npm?",
    });
    expect(notes[0]!.actions!.map((a) => a.label)).toEqual(["Install", "Language Servers…"]);
    await promptInstall("prettier", false);
    expect(notes.at(-1)).toMatchObject({
      key: missingKey("prettier"),
      sticky: false,
    });
    notes[0]!.actions![0]!.run();
    await waitFor(() =>
      expect(notes.at(-1)).toMatchObject({
        title: "Prettier installed",
        key: missingKey("prettier"),
      }),
    );
  });

  it("offers Install for installable servers, once, replacing the generic notice", async () => {
    const off = installMissingServerPrompts();
    const ev = {
      type: "languageServer",
      server: 1,
      name: "gopls",
      status: "missing",
      message: null,
    } as const;
    emitLocalIdeEvent(ev);
    emitLocalIdeEvent(ev);
    await waitFor(() => expect(notes).toHaveLength(1));
    const n = notes[0]!;
    expect(n.title).toBe("gopls is not installed");
    expect(n.key).toBe(missingKey("gopls"));
    n.actions![0]!.run();
    await waitFor(() => expect(backend.restarted).toEqual(["gopls"]));
    await waitFor(() =>
      expect(notes.at(-1)).toMatchObject({
        title: "gopls installed",
        key: missingKey("gopls"),
      }),
    );
    off();
  });

  it("offers Ruff formatting even when another Python server is installed", async () => {
    const installed = sampleTools().find((t) => t.name === "basedpyright")!;
    backend.tools.push({
      ...installed,
      name: "ruff",
      displayName: "Ruff",
      command: "ruff",
      installMethod: "uv (virtualenv)",
      languages: ["Python"],
      alternatives: [],
    });
    await promptInstall("ruff", true, new Set(), true);
    expect(notes.at(-1)).toMatchObject({
      title: "Ruff is not installed",
      body: "Reformat Code needs Ruff. Install it via uv (virtualenv)?",
      key: missingKey("ruff"),
    });
  });

  it("stays silent when an installed alternative serves the same languages", async () => {
    const off = installMissingServerPrompts();
    // typescript-language-server (on PATH) covers vtsls' languages.
    emitLocalIdeEvent({
      type: "languageServer",
      server: 4,
      name: "vtsls",
      status: "missing",
      message: null,
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(notes).toHaveLength(0);
    off();
  });

  it("offers only the first missing server of interchangeable ones", async () => {
    const off = installMissingServerPrompts();
    // basedpyright is missing, so its fallbacks start and turn out missing too; gopls isn't one of them.
    ["basedpyright", "pyright", "ty", "pyrefly", "gopls"].forEach((name, i) =>
      emitLocalIdeEvent({
        type: "languageServer",
        server: 10 + i,
        name,
        status: "missing",
        message: null,
      }),
    );
    await waitFor(() => expect(notes).toHaveLength(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(notes.map((n) => n.key)).toEqual([missingKey("basedpyright"), missingKey("gopls")]);
    off();
  });

  it("offers a fallback when the servers before it can't be installed", async () => {
    setToolsBackend(
      new MemoryToolsBackend(
        sampleTools().map((t) => (t.name === "basedpyright" ? { ...t, canInstall: false } : t)),
        1,
      ),
    );
    const off = installMissingServerPrompts();
    for (const [i, name] of ["basedpyright", "pyright", "ty"].entries()) {
      emitLocalIdeEvent({
        type: "languageServer",
        server: 20 + i,
        name,
        status: "missing",
        message: null,
      });
    }
    await waitFor(() => expect(notes).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(notes.map((n) => n.key)).toEqual([missingKey("pyright")]);
    off();
  });

  it("offers the first server that reports missing when earlier ones are off from the start", async () => {
    const off = installMissingServerPrompts();
    // basedpyright turned off in settings never starts, so never reports.
    for (const [i, name] of ["pyright", "ty"].entries()) {
      emitLocalIdeEvent({
        type: "languageServer",
        server: 40 + i,
        name,
        status: "missing",
        message: null,
      });
    }
    await waitFor(() => expect(notes).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(notes.map((n) => n.key)).toEqual([missingKey("pyright")]);
    off();
  });

  it("stays silent for tools without an installer", async () => {
    const off = installMissingServerPrompts();
    emitLocalIdeEvent({
      type: "languageServer",
      server: 2,
      name: "solargraph",
      status: "missing",
      message: null,
    });
    emitLocalIdeEvent({
      type: "languageServer",
      server: 3,
      name: "rust-analyzer",
      status: "ready",
      message: null,
    });
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
  const languages = () => screen.getByRole("list", { name: "Languages" });
  const language = (name: string) => languages().querySelector<HTMLElement>(`[data-language="${name}"]`);
  const toolItem = (name: string) => document.querySelector<HTMLElement>(`[data-tool="${name}"]`)!;
  const open = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await waitFor(() => expect(language(name)).not.toBeNull());
    await user.click(language(name)!);
    return screen.getByLabelText(`${name} tools`);
  };

  it("shows a language's tools and installs from the details", async () => {
    const user = userEvent.setup();
    renderPage();
    const go = await open(user, "Go");
    expect(within(go).getByText("Not set up")).toBeInTheDocument();
    expect(within(go).getByRole("list", { name: "Language Servers" })).toContainElement(toolItem("gopls"));
    expect(within(go).getByRole("list", { name: "Debuggers" })).toContainElement(toolItem("delve"));
    // The first tool is selected.
    expect(toolItem("gopls")).toHaveAttribute("aria-current", "true");
    expect(toolItem("gopls")).toHaveTextContent("Missing");
    const details = screen.getByLabelText("gopls details");
    await user.click(within(details).getByRole("button", { name: "Install gopls" }));
    await waitFor(() => expect(toolItem("gopls")).toHaveTextContent("1.0.0 · Installed"));
    expect(toolItem("gopls")).toHaveAttribute("aria-current", "true");
    expect(language("Go")).toHaveTextContent("1 missing");
    // The install log can be shown afterwards.
    await user.click(screen.getByRole("button", { name: "Show install log" }));
    expect(screen.getByLabelText("gopls install log")).toHaveTextContent("Installing gopls");
  });

  it("offers an update when a newer version of an installed tool is out", async () => {
    const user = userEvent.setup();
    backend.available = [{ name: "rust-analyzer", current: "1.85.0", latest: "1.86.0" }];
    renderPage();
    const rust = await open(user, "Rust");
    await waitFor(() => expect(toolItem("rust-analyzer")).toHaveTextContent("Update"));
    await user.click(toolItem("rust-analyzer"));
    const details = screen.getByLabelText("rust-analyzer details");
    expect(details).toHaveTextContent("Version 1.86.0 is available.");
    await user.click(within(details).getByRole("button", { name: "Update rust-analyzer" }));
    await waitFor(() => expect(toolItem("rust-analyzer")).not.toHaveTextContent("Update"));
    expect(within(rust).getByRole("button", { name: "Reinstall rust-analyzer" })).toBeInTheDocument();
    await open(user, "Go");
    expect(toolItem("gopls")).not.toHaveTextContent("Update");
  });

  it("installs what a language is missing in one go", async () => {
    const user = userEvent.setup();
    renderPage();
    const go = await open(user, "Go");
    await user.click(within(go).getByRole("button", { name: "Install Missing (2)" }));
    await waitFor(() => expect(within(screen.getByLabelText("Go tools")).getByText("Ready")).toBeInTheDocument());
    expect(language("Go")).not.toHaveTextContent("missing");
  });

  it("shows the picker of interchangeable servers once, above them", async () => {
    const user = userEvent.setup();
    renderPage();
    const python = await open(user, "Python");
    expect(
      within(python).getAllByRole("button", {
        name: "Language server for Python",
      }),
    ).toHaveLength(1);
    const rows = within(within(python).getByRole("list", { name: "Language Servers" })).getAllByRole("button", {
      name: /^(?!Install)/,
    });
    expect(rows.map((r) => r.dataset.tool)).toEqual(["basedpyright", "pyright", "ty", "pyrefly"]);
    await user.click(toolItem("ty"));
    expect(
      within(screen.getByLabelText("ty (Python) details")).queryByRole("button", { name: /^Language server/ }),
    ).toBeNull();
  });

  it("explains why a tool cannot be installed", async () => {
    const user = userEvent.setup();
    renderPage();
    await open(user, "Ruby");
    expect(screen.getByText("gem install solargraph")).toBeInTheDocument();
    await open(user, "Zig");
    expect(screen.getByText("curl is required to download tools")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Install Missing/ })).toBeNull();
  });

  it("notes the other languages a shared tool serves", async () => {
    const user = userEvent.setup();
    renderPage();
    await open(user, "Rust");
    await user.click(toolItem("codelldb"));
    expect(screen.getByLabelText("CodeLLDB details")).toHaveTextContent("Also used for C, C++");
  });

  it("stages and clears a custom path", async () => {
    const user = userEvent.setup();
    renderPage();
    await open(user, "Go");
    const path = within(screen.getByLabelText("gopls details")).getByRole("textbox", { name: "Path" });
    await user.type(path, "/opt/go/bin/gopls");
    expect(stagedFor("tools.gopls.path")).toBe("/opt/go/bin/gopls");
    await user.clear(path);
    expect(stagedFor("tools.gopls.path")).toBeNull();
    // Picked with the file chooser.
    backend.chosen = "/usr/local/bin/gopls";
    await user.click(
      within(screen.getByLabelText("gopls details")).getByRole("button", {
        name: "Browse…",
      }),
    );
    expect(stagedFor("tools.gopls.path")).toBe("/usr/local/bin/gopls");
    expect(path).toHaveValue("/usr/local/bin/gopls");
  });

  it("moves the selection with the arrow keys", async () => {
    const user = userEvent.setup();
    renderPage();
    await open(user, "Go");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByLabelText("JavaScript tools")).toBeInTheDocument();
  });

  it("filters to languages missing tools and by tool name", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(language("TypeScript")).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Show Only Languages Missing Tools" }));
    expect(language("TypeScript")).toBeNull();
    expect(language("Go")).not.toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Filter languages" }), "zls");
    expect(language("Go")).toBeNull();
    expect(language("Zig")).toHaveAttribute("aria-current", "true");
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
      registerAction({
        id: "file.settings",
        title: "Settings",
        run: ({ arg }) => void opened.push(arg),
      }),
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

describe("language server capability warning", () => {
  const event = {
    type: "languageServerWarning",
    name: "clangd",
    message:
      "Apple's clangd does not run clang-tidy, so checks from .clang-tidy are not shown. Install clangd (LLVM) to get them.",
    installTool: "clangd",
  } as const;

  it("offers a managed replacement for system clangd once and restarts it after installation", async () => {
    backend.tools.push({
      ...sampleTools()[0]!,
      name: "clangd",
      displayName: "clangd",
      command: "clangd",
      status: "onPath",
      path: "/usr/bin/clangd",
      languages: ["C", "C++", "Objective-C", "Objective-C++"],
    });
    const off = installServerWarningPrompts();
    try {
      emitLocalIdeEvent(event);
      emitLocalIdeEvent(event);
      await waitFor(() => expect(notes).toHaveLength(1));
      expect(notes[0]).toMatchObject({
        title: "clangd",
        level: "warning",
        sticky: true,
        body: event.message,
      });
      expect(notes[0]!.actions!.map((a) => a.label)).toEqual(["Install", "Language Servers…"]);
      notes[0]!.actions![0]!.run();
      await waitFor(() => expect(backend.restarted).toEqual(["clangd"]));
      expect(notes.at(-1)).toMatchObject({
        title: "clangd installed",
        key: notes[0]!.key,
      });
    } finally {
      off();
    }
  });

  it("keeps the Settings action when the tool cannot be installed", async () => {
    const off = installServerWarningPrompts();
    try {
      emitLocalIdeEvent(event);
      await waitFor(() => expect(notes).toHaveLength(1));
      expect(notes[0]!.actions!.map((a) => a.label)).toEqual(["Language Servers…"]);
    } finally {
      off();
    }
  });
});
