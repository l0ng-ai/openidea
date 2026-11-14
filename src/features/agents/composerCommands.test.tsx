import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendKeyAction } from "./Composer";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import type { AgentCommand, AgentProvider } from "@/bindings";

const agentCommands = vi.fn();
const agentCreate = vi.fn();
const vcsBranches = vi.fn();
const vcsBranchInfo = vi.fn();
const clipboardImage = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: vi.fn(() => true),
    commands: {
      ...real.commands,
      agentCommands: (provider: string, task: string | null) => agentCommands(provider, task),
      agentCreate: (request: unknown) => agentCreate(request),
      clipboardImage: () => clipboardImage(),
      vcsBranchInfo: (root: string | null) => vcsBranchInfo(root),
      vcsBranches: (root: string | null) => vcsBranches(root),
    },
  };
});
type DragDrop = {
  payload: {
    type: string;
    paths?: string[];
    position?: { x: number; y: number };
  };
};
const dragDrop = new Set<(event: DragDrop) => void>();
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: DragDrop) => void) => {
      dragDrop.add(handler);
      return Promise.resolve(() => dragDrop.delete(handler));
    },
  }),
}));
const invokeLocal = vi.fn();
vi.mock("@/platform/tauriCore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/tauriCore")>()),
  invokeLocal: (cmd: string, args: unknown) => invokeLocal(cmd, args),
}));

import { isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { ProjectInfo } from "@/bindings";
import { defaultTaskProject } from "./project";
import { HomeEditor } from "./HomeEditor";
import chipStyles from "./ReferenceChip.module.css";
import { setCaret, textOf, typeIn } from "./composerTesting";
import { composerDraft, HOME, updateComposer, useAgents } from "./store";
import { emptyDraft } from "./composerModel";

const command = (name: string, description: string, source: "command" | "skill" = "command"): AgentCommand => ({
  name,
  description,
  hint: null,
  source,
});
const claude: AgentProvider = {
  id: "claude",
  name: "Claude Code",
  command: "npx",
  installed: true,
  config: [],
  source: { kind: "builtin" },
  program: "claude",
  args: [],
  defaultProgram: "claude",
  defaultArgs: [],
  loginHint: null,
  commandOverridden: false,
  commandEditable: true,
  commandReadOnlyReason: null,
  env: {},
  // Offered by the agent's last session in this project.
  commands: [command("compact", "Free up context")],
};

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  useProject.setState({ project: null });
  vcsBranches.mockReset().mockResolvedValue({ status: "ok", data: [] });
  vcsBranchInfo.mockReset().mockImplementation((root: string | null) =>
    Promise.resolve({
      status: "ok",
      data: { head: root === "/project-b" ? "b-main" : "a-main" },
    }),
  );
  agentCommands.mockReset();
  clipboardImage.mockReset().mockResolvedValue({
    status: "ok",
    data: "data:image/png;base64,iVBORw0KGgo=",
  });
  agentCreate.mockReset().mockResolvedValue({
    status: "error",
    error: { kind: "invalid", message: "stop here" },
  });
  useAgents.setState({
    providers: [claude],
    draft: { provider: "claude", config: {}, isolation: "local", base: null },
  });
  updateComposer(HOME, emptyDraft());
});

describe("New Task composer commands", () => {
  it("reaches commands after the first twelve with the keyboard", async () => {
    agentCommands.mockResolvedValue({
      status: "ok",
      data: Array.from({ length: 30 }, (_, i) => command(`command-${i}`, "")),
    });
    render(<HomeEditor />);
    await waitFor(() => expect(agentCommands).toHaveBeenCalled());
    const box = screen.getByRole("textbox");
    typeIn(box, "/");
    await screen.findByRole("listbox", { name: "Commands" });
    for (let i = 0; i < 29; i++) fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(textOf(box)).toBe("/command-29 ");
  });

  it("groups commands before skills, skips headers, wraps and hides empty groups", async () => {
    agentCommands.mockResolvedValue({
      status: "ok",
      data: [command("triage", "", "skill"), command("compact", ""), command("review", "", "skill")],
    });
    render(<HomeEditor />);
    await waitFor(() => expect(agentCommands).toHaveBeenCalled());
    const box = screen.getByRole("textbox");
    typeIn(box, "/");
    const list = await screen.findByRole("listbox", { name: "Commands" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["/compact", "/triage", "/review"]);
    expect(list.textContent).toBe("Commands/compactSkills/triage/review");
    expect(within(list).getByRole("option", { selected: true })).toHaveTextContent("/compact");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(within(list).getByRole("option", { selected: true })).toHaveTextContent("/triage");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(within(list).getByRole("option", { selected: true })).toHaveTextContent("/review");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(within(list).getByRole("option", { selected: true })).toHaveTextContent("/compact");
    typeIn(box, "/tri");
    expect(list.textContent).toBe("Skills/triage");
    fireEvent.keyDown(box, { key: "Tab" });
    expect(textOf(box)).toBe("/triage ");
    typeIn(box, "/com");
    expect((await screen.findByRole("listbox", { name: "Commands" })).textContent).toBe("Commands/compact");
  });

  it("names the icon-only Start action and disables it while starting", async () => {
    agentCommands.mockResolvedValue({ status: "ok", data: [] });
    let finish!: (value: unknown) => void;
    agentCreate.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<HomeEditor />);
    const start = screen.getByRole("button", { name: "Start" });
    expect(start.textContent).toBe("");
    expect(start).toHaveAttribute("data-tooltip", "Start");
    expect(start).toBeDisabled();
    typeIn(screen.getByRole("textbox"), "Do the task");
    expect(start).toBeEnabled();
    fireEvent.click(start);
    const starting = screen.getByRole("button", { name: "Starting…" });
    expect(starting).toBeDisabled();
    expect(starting.textContent).toBe("");
    expect(starting).toHaveAttribute("data-tooltip", "Starting…");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(agentCreate).toHaveBeenCalledTimes(1);
    await act(async () =>
      finish({
        status: "error",
        error: { kind: "invalid", message: "stop here" },
      }),
    );
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("completes the project's skills merged with the agent's commands", async () => {
    agentCommands.mockResolvedValue({
      status: "ok",
      data: [
        command("compact", "Free up context"),
        command("triage", "One pass over open issues and PRs"),
        command("issue-fix", "Fix an issue"),
      ],
    });
    render(<HomeEditor />);
    await waitFor(() => expect(agentCommands).toHaveBeenCalledWith("claude", null));
    const box = screen.getByRole("textbox");
    typeIn(box, "/trig");
    const list = await screen.findByRole("listbox", { name: "Commands" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["/triageOne pass over open issues and PRs"]);

    fireEvent.keyDown(box, { key: "Enter" });
    expect(useAgents.getState().composers.get(HOME)?.text).toBe("/triage ");

    // Sent as typed, so the agent runs the skill.
    typeIn(box, "/triage dry-run");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(agentCreate).toHaveBeenCalled());
    expect(agentCreate.mock.calls[0]![0]).toMatchObject({
      prompt: { text: "/triage dry-run" },
      provider: "claude",
    });
  });

  it("tags file references and skills where they stand", async () => {
    agentCommands.mockResolvedValue({
      status: "ok",
      data: [command("triage", "One pass over issues")],
    });
    render(<HomeEditor />);
    await waitFor(() => expect(agentCommands).toHaveBeenCalled());
    const box = screen.getByRole("textbox");
    typeIn(box, "12 @Cargo.toml and /triage");
    expect(within(box).getByText("@Cargo.toml")).toHaveClass(chipStyles.pending!);
    expect(within(box).getByText("/triage")).toHaveClass(chipStyles.command!);
  });

  it("offers nothing the project does not have", async () => {
    agentCommands.mockResolvedValue({
      status: "ok",
      data: [command("compact", "Free up context")],
    });
    render(<HomeEditor />);
    await waitFor(() => expect(agentCommands).toHaveBeenCalled());
    const box = screen.getByRole("textbox");
    typeIn(box, "/trig");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    typeIn(box, "/com");
    expect(await screen.findByRole("option")).toHaveTextContent("/compact");
  });

  it("completes at the caret without replacing the rest of the message", async () => {
    const user = userEvent.setup();
    agentCommands.mockResolvedValue({
      status: "ok",
      data: [command("compact", "Free up context")],
    });
    render(<HomeEditor />);
    await waitFor(() => expect(agentCommands).toHaveBeenCalled());
    const box = screen.getByRole("textbox");
    box.focus();
    typeIn(box, "/com keep this context", 4);
    expect(await screen.findByRole("option")).toHaveTextContent("/compact");
    expect(box).toHaveFocus();

    await user.keyboard("{Tab}");
    expect(textOf(box)).toBe("/compact keep this context");
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull());
    expect(agentCreate).not.toHaveBeenCalled();
  });

  it("completes a command typed after other text in place", async () => {
    agentCommands.mockResolvedValue({
      status: "ok",
      data: [command("triage", "One pass over open issues and PRs")],
    });
    render(<HomeEditor />);
    await waitFor(() => expect(agentCommands).toHaveBeenCalled());
    const box = screen.getByRole("textbox");
    typeIn(box, "fix the failing build /tri");
    await screen.findByRole("listbox", { name: "Commands" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(useAgents.getState().composers.get(HOME)?.text).toBe("fix the failing build /triage ");
  });
});

describe("New Task composer paste", () => {
  it("attaches the clipboard's image when WebKitGTK pastes an empty clipboardData", async () => {
    render(<HomeEditor />);
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { types: [], files: [], getData: () => "" },
    });
    await waitFor(() =>
      expect(composerDraft(HOME).images).toEqual([{ mimeType: "image/png", data: "iVBORw0KGgo=", name: "image" }]),
    );
    expect(textOf(screen.getByRole("textbox"))).toBe("");
  });

  it.each([
    { name: "part of the prompt selected", text: "keep prompt", anchor: 0, head: 4 },
    { name: "the whole prompt selected", text: "keep prompt", anchor: 0, head: 11 },
    { name: "a backwards selection", text: "keep prompt", anchor: 4, head: 0 },
    { name: "a caret in the prompt", text: "keep prompt", anchor: 4, head: 4 },
    { name: "a multiline Unicode selection", text: "保留🙂\nprompt", anchor: 0, head: 5 },
  ])("keeps text and selection with $name when pasting a native image", async ({ text, anchor, head }) => {
    render(<HomeEditor />);
    const box = screen.getByRole("textbox");
    typeIn(box, text);
    setCaret(box, anchor, head);
    const allowed = fireEvent.paste(box, {
      clipboardData: { types: [], files: [], getData: () => "" },
    });
    expect(textOf(box)).toBe(text);
    expect(allowed).toBe(false);
    await waitFor(() => expect(composerDraft(HOME).images).toHaveLength(1));
    expect(clipboardImage).toHaveBeenCalledTimes(1);
    expect(composerDraft(HOME).text).toBe(text);
    expect(EditorView.findFromDOM(box)!.state.selection.main).toMatchObject({ anchor, head });
  });

  it.each([
    { name: "no image", result: { status: "ok", data: null } },
    { name: "an invalid image", result: { status: "ok", data: "not an image" } },
    { name: "an error", result: { status: "error", error: { kind: "internal", message: "clipboard busy" } } },
  ])("keeps selected text when the native clipboard returns $name", async ({ result }) => {
    clipboardImage.mockResolvedValueOnce(result);
    render(<HomeEditor />);
    const box = screen.getByRole("textbox");
    typeIn(box, "keep prompt");
    setCaret(box, 0, 4);
    await act(async () => {
      fireEvent.paste(box, { clipboardData: { types: [], files: [], getData: () => "" } });
    });
    expect(clipboardImage).toHaveBeenCalledTimes(1);
    expect(textOf(box)).toBe("keep prompt");
    expect(composerDraft(HOME)).toMatchObject({ text: "keep prompt", images: [] });
    expect(EditorView.findFromDOM(box)!.state.selection.main).toMatchObject({ anchor: 0, head: 4 });
  });

  it("keeps selected text when the native clipboard request rejects", async () => {
    clipboardImage.mockRejectedValueOnce(new Error("clipboard unavailable"));
    render(<HomeEditor />);
    const box = screen.getByRole("textbox");
    typeIn(box, "keep prompt");
    setCaret(box, 0, 4);
    await act(async () => {
      fireEvent.paste(box, { clipboardData: { types: [], files: [], getData: () => "" } });
    });
    expect(textOf(box)).toBe("keep prompt");
    expect(composerDraft(HOME)).toMatchObject({ text: "keep prompt", images: [] });
  });

  it("keeps edits made while the native image is being read", async () => {
    let finish!: (result: { status: "ok"; data: string }) => void;
    clipboardImage.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    render(<HomeEditor />);
    const box = screen.getByRole("textbox");
    typeIn(box, "keep prompt");
    setCaret(box, 0, 4);
    fireEvent.paste(box, { clipboardData: { types: [], files: [], getData: () => "" } });
    expect(textOf(box)).toBe("keep prompt");
    typeIn(box, "edited while reading");
    await act(async () => finish({ status: "ok", data: "data:image/png;base64,iVBORw0KGgo=" }));
    expect(textOf(box)).toBe("edited while reading");
    expect(composerDraft(HOME)).toMatchObject({ text: "edited while reading", images: [expect.anything()] });
  });

  it("attaches an image file without replacing selected text or reading the native clipboard", async () => {
    render(<HomeEditor />);
    const box = screen.getByRole("textbox");
    typeIn(box, "keep prompt");
    setCaret(box, 0, 4);
    fireEvent.paste(box, {
      clipboardData: {
        types: ["Files", "text/plain"],
        files: [new File(["image"], "shot.png", { type: "image/png" })],
        getData: () => "image caption",
      },
    });
    await waitFor(() => expect(composerDraft(HOME).images).toHaveLength(1));
    expect(composerDraft(HOME).images[0]).toMatchObject({ name: "shot.png", mimeType: "image/png" });
    expect(textOf(box)).toBe("keep prompt");
    expect(clipboardImage).not.toHaveBeenCalled();
  });

  it("leaves a text paste to the text box", () => {
    render(<HomeEditor />);
    const box = screen.getByRole("textbox");
    const text = "pasted text";
    fireEvent.paste(box, {
      clipboardData: {
        types: ["text/plain"],
        files: [],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    });
    expect(clipboardImage).not.toHaveBeenCalled();
    expect(textOf(box)).toBe(text);
    expect(composerDraft(HOME).text).toBe(text);
  });

  it.each([
    { name: "plain text", types: ["text/plain"], format: "text/plain", text: "new", native: true },
    { name: "rich text", types: ["text/html", "text/plain"], format: "text/plain", text: "新的🙂", native: true },
    { name: "a URI", types: ["text/uri-list"], format: "text/uri-list", text: "https://example.com", native: true },
    { name: "browser text", types: ["text/plain"], format: "text/plain", text: "new", native: false },
  ])("still replaces selected text when pasting $name", ({ types, format, text, native }) => {
    vi.mocked(isTauri).mockReturnValue(native);
    render(<HomeEditor />);
    const box = screen.getByRole("textbox");
    typeIn(box, "keep old prompt");
    setCaret(box, 5, 8);
    fireEvent.paste(box, {
      clipboardData: { types, files: [], getData: (type: string) => (type === format ? text : "") },
    });
    expect(textOf(box)).toBe(`keep ${text} prompt`);
    expect(composerDraft(HOME)).toMatchObject({ text: `keep ${text} prompt`, images: [] });
    expect(clipboardImage).not.toHaveBeenCalled();
  });
});

describe("New Task composer OS file drop", () => {
  const drop = (paths: string[]) =>
    act(() => dragDrop.forEach((handler) => handler({ payload: { type: "drop", paths, position: { x: 0, y: 0 } } })));

  it("attaches files from outside the project and images that cannot be inlined", async () => {
    invokeLocal
      .mockReset()
      .mockImplementation((_cmd: string, args: { path: string }) =>
        args.path.endsWith("shot.png")
          ? Promise.resolve("data:image/png;base64,iVBORw0KGgo=")
          : Promise.reject(new Error("too large")),
      );
    render(<HomeEditor />);
    await waitFor(() => expect(dragDrop.size).toBeGreaterThan(0));
    drop(["/Users/me/Desktop/recording one.mov", "/Users/me/Desktop/shot.png", "/Users/me/Desktop/huge.png"]);
    await waitFor(() => expect(composerDraft(HOME).files).toHaveLength(2));
    expect(composerDraft(HOME)).toEqual({
      text: "",
      files: [
        {
          path: "/Users/me/Desktop/recording one.mov",
          rel: "recording one.mov",
          attached: true,
        },
        { path: "/Users/me/Desktop/huge.png", rel: "huge.png", attached: true },
      ],
      images: [{ mimeType: "image/png", data: "iVBORw0KGgo=", name: "shot.png" }],
    });
    expect(screen.getByTitle("/Users/me/Desktop/recording one.mov")).toHaveTextContent("recording one.mov");
    fireEvent.click(
      within(screen.getByTitle("/Users/me/Desktop/huge.png")).getByRole("button", { name: "Remove File" }),
    );
    expect(composerDraft(HOME).files.map((f) => f.rel)).toEqual(["recording one.mov"]);
  });
});

describe("workspace task project", () => {
  const project = {
    root: "/workspace",
    name: "Workspace",
    trusted: true,
    isGit: false,
    workspace: {
      version: 1,
      name: "Workspace",
      projects: ["/project-a", "/project-b"],
    },
  } as ProjectInfo;
  it("defaults to the active member, last used member, then first member", () => {
    expect(defaultTaskProject(project, "/project-b/src/main.ts", "/project-a")).toBe("/project-b");
    expect(defaultTaskProject(project, null, "/project-b")).toBe("/project-b");
    expect(defaultTaskProject(project, "/project-b-other/file", "/removed")).toBe("/project-a");
    expect(defaultTaskProject({ ...project, workspace: null }, "/project-b/file", "/project-b")).toBe("/workspace");
  });
  it.each(["local", "worktree"] as const)("sends the selected project with %s isolation", async (isolation) => {
    vi.mocked(isTauri).mockReturnValue(false);
    useProject.setState({ project });
    agentCommands.mockResolvedValue({ status: "ok", data: [] });
    useAgents.setState({
      draft: {
        ...useAgents.getState().draft,
        projectRoot: "/project-b",
        isolation,
      },
    });
    render(<HomeEditor />);
    const selector = screen.getByRole("button", { name: "Project" });
    expect(selector).toHaveTextContent("project-b");
    await waitFor(() => expect(vcsBranchInfo).toHaveBeenCalledWith("/project-b"));
    expect(vcsBranches).toHaveBeenCalledWith("/project-b");
    fireEvent.click(selector);
    expect(within(screen.getByRole("listbox")).getByText("/project-a")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /project-a/ }));
    typeIn(screen.getByRole("textbox"), "Update member");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(agentCreate).toHaveBeenCalled());
    expect(agentCreate.mock.calls[0]![0]).toMatchObject({
      projectRoot: "/project-a",
      isolation,
    });
    expect(vcsBranchInfo).toHaveBeenLastCalledWith("/project-a");
    expect(vcsBranches).toHaveBeenLastCalledWith("/project-a");
    await vi.dynamicImportSettled();
  });
});

describe("sendKeyAction", () => {
  const key = (k: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...k,
  });
  it("sends with Enter, or with the modifier, the way the settings say", () => {
    expect(sendKeyAction(key(), "enter", "queue")).toBe("queue");
    expect(sendKeyAction(key({ metaKey: true }), "enter", "queue")).toBe("now");
    expect(sendKeyAction(key({ shiftKey: true }), "enter", "queue")).toBeNull();
    expect(sendKeyAction(key(), "enter", "steer")).toBe("now");
    expect(sendKeyAction(key(), "modEnter", "queue")).toBeNull();
    expect(sendKeyAction(key({ ctrlKey: true }), "modEnter", "queue")).toBe("queue");
    expect(sendKeyAction(key({ metaKey: true, shiftKey: true }), "modEnter", "queue")).toBe("now");
    expect(sendKeyAction({ ...key(), key: "a" }, "enter", "queue")).toBeNull();
  });
});
