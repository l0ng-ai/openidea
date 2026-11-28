// @vitest-environment jsdom
import { Terminal, type IDecoration, type IDecorationOptions } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerActions } from "@/platform/actions";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { _resetTerminalHomeForTests } from "./home";
import { findPathCandidates, findTerminalLinks } from "./links";
import {
  PATH_HOVER_CLASS,
  installModifierPathLinks,
  isPathLinkModifier,
  openPathTarget,
  resolvePathTarget,
} from "./pathLinks";

const mocks = vi.hoisted(() => ({
  highlightHyperlinks: true,
  entryKinds: new Map<string, "file" | "dir">(),
  findFiles: vi.fn<(_q: string, _limit: number) => Promise<Array<{ path: string; relPath: string }>>>(async () => []),
  openFile: vi.fn(async (_path: string, _opts?: unknown) => undefined),
  revealInFileManager: vi.fn(async (_path: string) => true),
  homeDir: "/Users/alice",
  systemEnv: vi.fn<() => Promise<Record<string, string>>>(async () => ({})),
}));

vi.mock("@/platform/ipc", () => ({
  isTauri: () => true,
  call: async <T>(p: Promise<T>) => p,
  commands: {
    fsEntryKind: vi.fn(async (path: string) => {
      const kind = mocks.entryKinds.get(path);
      if (!kind) throw new Error(`ENOENT: ${path}`);
      return kind;
    }),
    findFiles: (q: string, limit: number) => mocks.findFiles(q, limit),
    runSystemEnv: () => mocks.systemEnv(),
  },
}));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => mocks.homeDir,
}));
vi.mock("@/platform/fileManager", () => ({
  revealInFileManager: (path: string) => mocks.revealInFileManager(path),
}));
vi.mock("@/platform/workflowSettings", () => ({
  workflowSettings: () => ({ terminal: { highlightHyperlinks: mocks.highlightHyperlinks } }),
}));
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  editorService: () => ({ openFile: mocks.openFile }),
}));

import { commands } from "@/platform/ipc";

const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));

describe("findPathCandidates", () => {
  it("extracts bare files, folders, flags=path and quoted spaced paths while skipping URLs, file:line and numbers", () => {
    const line =
      'drwxr-xr-x 12 4096 22:10 README.md src/ --config=config/app.json "my dir/hello world.ts" https://a.dev a.rs:10:2 -la . ..';
    const got = findPathCandidates(line).map((c) => c.path);
    expect(got).toContain("README.md");
    expect(got).toContain("src/");
    expect(got).toContain("config/app.json");
    expect(got).toContain("my dir/hello world.ts");
    expect(got).not.toContain("4096");
    expect(got).not.toContain("22:10");
    expect(got).not.toContain("-la");
    expect(got).not.toContain(".");
    expect(got).not.toContain("..");
    expect(got).not.toContain("https://a.dev");
    expect(got).not.toContain("a.rs:10:2");
  });

  it("orders an outer quoted path ahead of inner tokens so spaced paths win when they exist and prose falls back when not", () => {
    const candidates = findPathCandidates('"see src/App.tsx now"');
    expect(candidates[0]?.path).toBe("see src/App.tsx now");
    expect(candidates.map((c) => c.path)).toContain("src/App.tsx");
  });
});

describe("isPathLinkModifier", () => {
  it("requires ⌘ on macOS and Ctrl on Windows/Linux without competing modifiers", () => {
    expect(isPathLinkModifier({ metaKey: true, ctrlKey: false, altKey: false }, "macos")).toBe(true);
    expect(isPathLinkModifier({ metaKey: false, ctrlKey: true, altKey: false }, "macos")).toBe(false);
    expect(isPathLinkModifier({ metaKey: true, ctrlKey: false, altKey: true }, "macos")).toBe(false);

    expect(isPathLinkModifier({ metaKey: false, ctrlKey: true, altKey: false }, "linux")).toBe(true);
    expect(isPathLinkModifier({ metaKey: false, ctrlKey: true, altKey: false }, "windows")).toBe(true);
    expect(isPathLinkModifier({ metaKey: true, ctrlKey: false, altKey: false }, "windows")).toBe(false);
  });
});

describe("resolvePathTarget — existence & project-scope matrix", () => {
  beforeEach(() => {
    mocks.entryKinds.clear();
    mocks.findFiles.mockReset().mockResolvedValue([]);
    _resetTerminalHomeForTests();
    useProject.setState({ project: { root: "/repo" } as never });
  });
  afterEach(() => {
    useProject.setState({ project: null, settings: null });
    vi.clearAllMocks();
  });

  it("resolves existing in-project files and folders relative to cwd or project root", async () => {
    mocks.entryKinds.set("/repo/sub/local.ts", "file");
    mocks.entryKinds.set("/repo/src/features", "dir");
    mocks.entryKinds.set("/repo/Makefile", "file");

    expect(await resolvePathTarget("local.ts", "/repo/sub")).toEqual({ kind: "file", path: "/repo/sub/local.ts" });
    expect(await resolvePathTarget("Makefile", "/repo/sub")).toEqual({ kind: "file", path: "/repo/Makefile" });
    expect(await resolvePathTarget("src/features/", "/repo/sub")).toEqual({ kind: "dir", path: "/repo/src/features" });
  });

  it("returns null for non-existent in-project files and folders, and rejects file/ with a trailing slash", async () => {
    mocks.entryKinds.set("/repo/README.md", "file");
    expect(await resolvePathTarget("missing.ts", "/repo")).toBeNull();
    expect(await resolvePathTarget("missing_dir", "/repo")).toBeNull();
    expect(await resolvePathTarget("missing_dir/", "/repo")).toBeNull();
    expect(await resolvePathTarget("README.md/", "/repo")).toBeNull();
  });

  it("resolves existing out-of-project files and folders (absolute, ../, and ~), and returns null when absent", async () => {
    mocks.entryKinds.set("/tmp/outside.log", "file");
    mocks.entryKinds.set("/tmp/outside-dir", "dir");
    mocks.entryKinds.set("/Users/alice/Downloads", "dir");
    mocks.entryKinds.set("/sibling/notes.txt", "file");
    mocks.findFiles.mockResolvedValue([{ path: "/repo/src/outside.log", relPath: "src/outside.log" }]);

    expect(await resolvePathTarget("/tmp/outside.log", "/repo")).toEqual({ kind: "file", path: "/tmp/outside.log" });
    expect(await resolvePathTarget("/tmp/outside-dir", "/repo")).toEqual({ kind: "dir", path: "/tmp/outside-dir" });
    expect(await resolvePathTarget("~/Downloads", "/repo")).toEqual({ kind: "dir", path: "/Users/alice/Downloads" });
    expect(await resolvePathTarget("../sibling/notes.txt", "/repo")).toEqual({
      kind: "file",
      path: "/sibling/notes.txt",
    });

    // Explicit paths that do not exist must NEVER fall back to `findFiles` inside the project.
    expect(await resolvePathTarget("/tmp/missing-outside.log", "/repo")).toBeNull();
    expect(await resolvePathTarget("./outside.log", "/repo")).toBeNull();
    expect(await resolvePathTarget("/tmp/missing-dir", "/repo")).toBeNull();
    expect(mocks.findFiles).not.toHaveBeenCalled();
  });

  it("resolves git diff a/ and b/ prefixes and unique project filenames via findFiles", async () => {
    mocks.entryKinds.set("/repo/src/App.tsx", "file");
    expect(await resolvePathTarget("b/src/App.tsx", "/repo")).toEqual({ kind: "file", path: "/repo/src/App.tsx" });

    mocks.findFiles.mockResolvedValueOnce([
      { path: "/repo/src/features/terminal/TerminalView.tsx", relPath: "src/features/terminal/TerminalView.tsx" },
    ]);
    expect(await resolvePathTarget("TerminalView.tsx", "/repo")).toEqual({
      kind: "file",
      path: "/repo/src/features/terminal/TerminalView.tsx",
    });
  });
});

// The reporter's list from #6246: a WSL window on Windows, project `/home/linux/projects/odin_learning`.
describe("resolvePathTarget — #6246 paths", () => {
  const root = "/home/linux/projects/odin_learning";
  const files = [
    "README.md",
    ".gitignore",
    "docs/wsl2_tooling.md",
    "scripts/check_python.py",
    "python_how_to/050_for_while_and_loop_else.py",
    ".agents/scripts/scope_guard.py",
    ".scratch/python-how-to-v2/spec.md",
  ];
  const dirs = ["docs", ".agents", ".agents/scripts", "how_to_blueprint", "python_how_to"];
  const wsl = { target: { kind: "wsl", distro: "Ubuntu" }, root, host: "Ubuntu", os: "linux", commands: [] };

  beforeEach(() => {
    mocks.entryKinds.clear();
    mocks.findFiles.mockReset().mockResolvedValue([]);
    mocks.systemEnv.mockReset().mockResolvedValue({ HOME: "/home/linux", PATH: "/usr/bin" });
    _resetTerminalHomeForTests();
    for (const f of files) mocks.entryKinds.set(`${root}/${f}`, "file");
    for (const d of dirs) mocks.entryKinds.set(`${root}/${d}`, "dir");
    mocks.entryKinds.set("/home/linux/projects/Pseudocode/skills/pseudocode/SKILL.md", "file");
    mocks.entryKinds.set("/home/linux/.agents/skills/pseudocode/SKILL.md", "file");
    useProject.setState({ project: { root } as never });
    useRemote.setState({ session: wsl as never });
  });
  afterEach(() => {
    useProject.setState({ project: null, settings: null });
    useRemote.setState({ session: null });
    vi.clearAllMocks();
  });

  it.each([
    [".agents/scripts/scope_guard.py", ".scratch/python-how-to-v2/spec.md"],
    ["'.agents/scripts/scope_guard.py'", "'.scratch/python-how-to-v2/spec.md'"],
    ["./.agents/scripts/scope_guard.py", "./.scratch/python-how-to-v2/spec.md"],
    ["Check .agents/scripts/scope_guard.py, and x.", "Check .scratch/python-how-to-v2/spec.md, and x."],
  ])("detects %s exactly like its .scratch twin", (agents, scratch) => {
    const paths = (line: string) => findPathCandidates(line).map((c) => c.path);
    expect(paths(agents)).toContain(agents.match(/[./\w-]*scope_guard\.py/)![0]);
    expect(paths(scratch)).toContain(scratch.match(/[./\w-]*spec\.md/)![0]);
    expect(paths(agents).length).toBe(paths(scratch).length);
  });

  it("links `.agents/…:24` and `.agents/…:24:9` like any other location", () => {
    expect(findTerminalLinks(".agents/scripts/scope_guard.py:24")).toMatchObject([
      { kind: "file", path: ".agents/scripts/scope_guard.py", line: 24 },
    ]);
    expect(findTerminalLinks(".agents/scripts/scope_guard.py:24:9")).toMatchObject([
      { kind: "file", path: ".agents/scripts/scope_guard.py", line: 24, col: 9 },
    ]);
  });

  it.each([
    // Workspace-relative, dot files and dot folders alike.
    ["README.md", `${root}/README.md`],
    [".gitignore", `${root}/.gitignore`],
    [".agents/scripts/scope_guard.py", `${root}/.agents/scripts/scope_guard.py`],
    [".scratch/python-how-to-v2/spec.md", `${root}/.scratch/python-how-to-v2/spec.md`],
    ["./docs/wsl2_tooling.md", `${root}/docs/wsl2_tooling.md`],
    ["./.agents/scripts/scope_guard.py", `${root}/.agents/scripts/scope_guard.py`],
    ["../odin_learning/docs/wsl2_tooling.md", `${root}/docs/wsl2_tooling.md`],
    ["../Pseudocode/skills/pseudocode/SKILL.md", "/home/linux/projects/Pseudocode/skills/pseudocode/SKILL.md"],
    [`${root}/.agents/scripts/scope_guard.py`, `${root}/.agents/scripts/scope_guard.py`],
    // `~` is the WSL user's home, not the Windows desktop's.
    ["~/projects/odin_learning/docs/wsl2_tooling.md", `${root}/docs/wsl2_tooling.md`],
    ["~/projects/odin_learning/.agents/scripts/scope_guard.py", `${root}/.agents/scripts/scope_guard.py`],
    ["~/projects/Pseudocode/skills/pseudocode/SKILL.md", "/home/linux/projects/Pseudocode/skills/pseudocode/SKILL.md"],
    ["~/.agents/skills/pseudocode/SKILL.md", "/home/linux/.agents/skills/pseudocode/SKILL.md"],
  ])("resolves the file %s from the project root in a WSL window", async (raw, path) => {
    expect(await resolvePathTarget(raw, root)).toEqual({ kind: "file", path });
    expect(mocks.findFiles).not.toHaveBeenCalled();
  });

  it.each([
    ["docs/", `${root}/docs`],
    ["./docs/", `${root}/docs`],
    [".agents/scripts/", `${root}/.agents/scripts`],
    ["~/projects/odin_learning/how_to_blueprint/", `${root}/how_to_blueprint`],
  ])("resolves the folder %s in a WSL window", async (raw, path) => {
    expect(await resolvePathTarget(raw, root)).toEqual({ kind: "dir", path });
  });

  it("never expands `~` to this desktop's home in a remote window, and asks again once the host answers", async () => {
    mocks.entryKinds.set("/Users/alice/projects/odin_learning/docs/wsl2_tooling.md", "file");
    mocks.systemEnv.mockRejectedValueOnce(new Error("disconnected"));
    expect(await resolvePathTarget("~/projects/odin_learning/docs/wsl2_tooling.md", root)).toBeNull();
    expect(await resolvePathTarget("~/projects/odin_learning/docs/wsl2_tooling.md", root)).toEqual({
      kind: "file",
      path: `${root}/docs/wsl2_tooling.md`,
    });
  });

  it("keeps the local and the remote home apart when the window switches", async () => {
    mocks.entryKinds.set("/Users/alice/notes.md", "file");
    mocks.entryKinds.set("/home/linux/notes.md", "file");
    useRemote.setState({ session: null });
    expect(await resolvePathTarget("~/notes.md", "/")).toEqual({ kind: "file", path: "/Users/alice/notes.md" });
    useRemote.setState({ session: wsl as never });
    expect(await resolvePathTarget("~/notes.md", "/")).toEqual({ kind: "file", path: "/home/linux/notes.md" });
    expect(mocks.systemEnv).toHaveBeenCalledTimes(1);
  });

  it("uses %USERPROFILE% for `~` on a Windows SSH host", async () => {
    useRemote.setState({
      session: { ...wsl, target: { kind: "ssh", config: "win" }, host: "win", os: "windows" } as never,
    });
    mocks.systemEnv.mockResolvedValue({ USERPROFILE: "C:\\Users\\me" });
    mocks.entryKinds.set("C:/Users/me/projects/a.txt", "file");
    expect(await resolvePathTarget("~\\projects\\a.txt", "C:\\p")).toEqual({
      kind: "file",
      path: "C:/Users/me/projects/a.txt",
    });
    expect(await resolvePathTarget("~/projects/a.txt", "C:\\p")).toEqual({
      kind: "file",
      path: "C:/Users/me/projects/a.txt",
    });
  });
});

describe("openPathTarget", () => {
  afterEach(() => vi.clearAllMocks());

  it("opens both in-project and out-of-project files in the current window's editor", async () => {
    await openPathTarget({ kind: "file", path: "/repo/src/App.tsx" });
    expect(mocks.openFile).toHaveBeenCalledWith("/repo/src/App.tsx", { focus: true });

    await openPathTarget({ kind: "file", path: "/tmp/outside.log" });
    expect(mocks.openFile).toHaveBeenCalledWith("/tmp/outside.log", { focus: true });
  });

  it("routes folders through navigate.selectIn (expand + revealOutside) and falls back to OS file manager", async () => {
    const selectIn = vi.fn();
    const dispose = registerActions([{ id: "navigate.selectIn", title: "Select In", run: ({ arg }) => selectIn(arg) }]);
    try {
      await openPathTarget({ kind: "dir", path: "/repo/src" });
      expect(selectIn).toHaveBeenCalledWith({ path: "/repo/src", expand: true, revealOutside: true });
      expect(mocks.revealInFileManager).not.toHaveBeenCalled();
    } finally {
      dispose();
    }

    await openPathTarget({ kind: "dir", path: "/tmp/outside-dir" });
    expect(mocks.revealInFileManager).toHaveBeenCalledWith("/tmp/outside-dir");
  });
});

describe("installModifierPathLinks — hover & click interactions", () => {
  const terms: Terminal[] = [];
  const created: Array<{ options: IDecorationOptions; decoration: IDecoration }> = [];
  const prevOs = usePlatform.getState().os;

  beforeEach(() => {
    usePlatform.setState({ os: "macos" });
    useProject.setState({ project: { root: "/repo" } as never });
    mocks.highlightHyperlinks = true;
    mocks.entryKinds.clear();
    mocks.findFiles.mockReset().mockResolvedValue([]);
    created.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    while (terms.length) terms.pop()!.dispose();
    document.body.replaceChildren();
    usePlatform.setState({ os: prevOs });
    useProject.setState({ project: null, settings: null });
  });

  function setupTerm(cols = 60, rows = 4) {
    window.matchMedia ??= (() =>
      ({
        matches: false,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 100 });
    term.open(host);
    const screen = term.element!.querySelector<HTMLElement>(".xterm-screen")!;
    vi.spyOn(screen, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, cols * 10, rows * 20));
    const register = term.registerDecoration.bind(term);
    term.registerDecoration = (options) => {
      const decoration = register(options);
      if (decoration) created.push({ options, decoration });
      return decoration;
    };
    const controller = installModifierPathLinks(term, host, {
      cwd: () => "/repo",
      color: () => "#3574f0",
    });
    terms.push(term);
    return { term, host, controller };
  }

  const liveDecorations = () =>
    created
      .filter((d) => !d.decoration.isDisposed)
      .map(({ options: o }) => ({ x: o.x, width: o.width, fg: o.foregroundColor }));

  it("ignores plain hover/click, activates on ⌘ while stationary, and ignores non-existent targets", async () => {
    mocks.entryKinds.set("/repo/App.tsx", "file");
    mocks.entryKinds.set("/repo/src", "dir");
    const { term, host, controller } = setupTerm();
    await write(term, "App.tsx  missing.ts  src");

    // 1) Plain hover over App.tsx (col 2 => x = 25, y = 10): zero IPC, no decoration.
    host.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 25, clientY: 10 }));
    expect(commands.fsEntryKind).not.toHaveBeenCalled();
    expect(liveDecorations()).toEqual([]);
    expect(term.element).not.toHaveClass(PATH_HOVER_CLASS);

    // 2) Press ⌘ while already hovering App.tsx (no mouse movement): becomes a hyperlink!
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true, bubbles: true }));
    await vi.waitFor(() => expect(liveDecorations()).toEqual([{ x: 0, width: 7, fg: "#3574f0" }]));
    expect(term.element).toHaveClass(PATH_HOVER_CLASS);

    // 3) Move with ⌘ held onto non-existent `missing.ts` (cols 9..18 => x = 125): no link!
    host.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 125, clientY: 10, metaKey: true }));
    await vi.waitFor(() => expect(commands.fsEntryKind).toHaveBeenCalledWith("/repo/missing.ts"));
    expect(liveDecorations()).toEqual([]);
    expect(term.element).not.toHaveClass(PATH_HOVER_CLASS);

    // Clicking non-existent `missing.ts` with ⌘ opens nothing and never leaves a dangling mousedown selection.
    host.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 125, clientY: 10, metaKey: true }),
    );
    host.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 125, clientY: 10, metaKey: true }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.openFile).not.toHaveBeenCalled();
    expect(term.hasSelection()).toBe(false);

    // 4) Move onto existing `src` (cols 21..23 => x = 215) with ⌘ held, then release ⌘.
    host.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 215, clientY: 10, metaKey: true }));
    await vi.waitFor(() => expect(liveDecorations()).toEqual([{ x: 21, width: 3, fg: "#3574f0" }]));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", metaKey: false, bubbles: true }));
    expect(liveDecorations()).toEqual([]);
    expect(term.element).not.toHaveClass(PATH_HOVER_CLASS);

    // 5) Re-press ⌘ and click `App.tsx`: opens in editor!
    host.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 25, clientY: 10, metaKey: true }));
    await vi.waitFor(() => expect(liveDecorations()).toHaveLength(1));
    host.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 25, clientY: 10, metaKey: true }),
    );
    host.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 25, clientY: 10, metaKey: true }),
    );
    await vi.waitFor(() => expect(mocks.openFile).toHaveBeenCalledWith("/repo/App.tsx", { focus: true }));

    controller.dispose();
  });

  it("invalidates its probe cache when new terminal output arrives (e.g. after creating a file)", async () => {
    const { term, host, controller } = setupTerm();
    await write(term, "fresh.txt");

    host.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 15, clientY: 10, metaKey: true }));
    await vi.waitFor(() => expect(commands.fsEntryKind).toHaveBeenCalledTimes(1));
    expect(liveDecorations()).toEqual([]);

    // File is created and new output arrives in the terminal.
    mocks.entryKinds.set("/repo/fresh.txt", "file");
    await write(term, "\r\nfresh.txt");
    host.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 15, clientY: 30, metaKey: true }));
    await vi.waitFor(() => expect(liveDecorations()).toEqual([{ x: 0, width: 9, fg: "#3574f0" }]));

    controller.dispose();
  });
});
