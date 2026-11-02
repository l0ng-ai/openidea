import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentCommand, AgentProvider } from "@/bindings";

const agentCommands = vi.fn();
const agentCreate = vi.fn();
const vcsBranches = vi.fn();
const vcsBranchInfo = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: vi.fn(() => true),
    commands: {
      ...real.commands,
      agentCommands: (provider: string, task: string | null) => agentCommands(provider, task),
      agentCreate: (request: unknown) => agentCreate(request),
      vcsBranchInfo: (root: string | null) => vcsBranchInfo(root),
      vcsBranches: (root: string | null) => vcsBranches(root),
    },
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { ProjectInfo } from "@/bindings";
import { defaultTaskProject } from "./project";
import { HomeEditor } from "./HomeEditor";
import { HOME, updateComposer, useAgents } from "./store";
import { emptyDraft } from "./composerModel";

const command = (name: string, description: string): AgentCommand => ({ name, description, hint: null });
const claude: AgentProvider = {
  id: "claude",
  name: "Claude Code",
  command: "npx",
  installed: true,
  config: [],
  source: { kind: "builtin" },
  // Offered by the agent's last session in this project.
  commands: [command("compact", "Free up context")],
};

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  useProject.setState({ project: null });
  vcsBranches.mockReset().mockResolvedValue({ status: "ok", data: [] });
  vcsBranchInfo
    .mockReset()
    .mockImplementation((root: string | null) =>
      Promise.resolve({ status: "ok", data: { head: root === "/project-b" ? "b-main" : "a-main" } }),
    );
  agentCommands.mockReset();
  agentCreate.mockReset().mockResolvedValue({ status: "error", error: { kind: "invalid", message: "stop here" } });
  useAgents.setState({
    providers: [claude],
    draft: { provider: "claude", config: {}, isolation: "local", base: null },
  });
  updateComposer(HOME, emptyDraft());
});

describe("New Task composer commands", () => {
  it("names the icon-only Start action and disables it while starting", async () => {
    agentCommands.mockResolvedValue({ status: "ok", data: [] });
    let finish!: (value: unknown) => void;
    agentCreate.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<HomeEditor />);
    const start = screen.getByRole("button", { name: "Start" });
    expect(start.textContent).toBe("");
    expect(start).toHaveAttribute("data-tooltip", "Start");
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Do the task" } });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    const starting = screen.getByRole("button", { name: "Starting…" });
    expect(starting).toBeDisabled();
    expect(starting.textContent).toBe("");
    expect(starting).toHaveAttribute("data-tooltip", "Starting…");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(agentCreate).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: "error", error: { kind: "invalid", message: "stop here" } }));
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
    fireEvent.change(box, { target: { value: "/trig" } });
    const list = await screen.findByRole("listbox", { name: "Commands" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["/triageOne pass over open issues and PRs"]);

    fireEvent.keyDown(box, { key: "Enter" });
    expect(useAgents.getState().composers.get(HOME)?.text).toBe("/triage ");

    // Sent as typed, so the agent runs the skill.
    fireEvent.change(box, { target: { value: "/triage dry-run" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(agentCreate).toHaveBeenCalled());
    expect(agentCreate.mock.calls[0]![0]).toMatchObject({ prompt: { text: "/triage dry-run" }, provider: "claude" });
  });

  it("offers nothing the project does not have", async () => {
    agentCommands.mockResolvedValue({ status: "ok", data: [command("compact", "Free up context")] });
    render(<HomeEditor />);
    await waitFor(() => expect(agentCommands).toHaveBeenCalled());
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/trig" } });
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    fireEvent.change(box, { target: { value: "/com" } });
    expect(await screen.findByRole("option")).toHaveTextContent("/compact");
  });

  it("completes at the caret without replacing the rest of the message", async () => {
    const user = userEvent.setup();
    agentCommands.mockResolvedValue({ status: "ok", data: [command("compact", "Free up context")] });
    render(<HomeEditor />);
    await waitFor(() => expect(agentCommands).toHaveBeenCalled());
    const box = screen.getByRole("textbox");
    box.focus();
    fireEvent.change(box, { target: { value: "/com keep this context", selectionStart: 4, selectionEnd: 4 } });
    expect(await screen.findByRole("option")).toHaveTextContent("/compact");
    expect(box).toHaveFocus();

    await user.keyboard("{Tab}");
    expect(box).toHaveValue("/compact keep this context");
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull());
    expect(agentCreate).not.toHaveBeenCalled();
  });
});

describe("workspace task project", () => {
  const project = {
    root: "/workspace",
    name: "Workspace",
    trusted: true,
    isGit: false,
    workspace: { version: 1, name: "Workspace", projects: ["/project-a", "/project-b"] },
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
    useAgents.setState({ draft: { ...useAgents.getState().draft, projectRoot: "/project-b", isolation } });
    render(<HomeEditor />);
    const selector = screen.getByRole("button", { name: "Project" });
    expect(selector).toHaveTextContent("project-b");
    await waitFor(() => expect(vcsBranchInfo).toHaveBeenCalledWith("/project-b"));
    expect(vcsBranches).toHaveBeenCalledWith("/project-b");
    fireEvent.click(selector);
    expect(within(screen.getByRole("listbox")).getByText("/project-a")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /project-a/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Update member" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(agentCreate).toHaveBeenCalled());
    expect(agentCreate.mock.calls[0]![0]).toMatchObject({ projectRoot: "/project-a", isolation });
    expect(vcsBranchInfo).toHaveBeenLastCalledWith("/project-a");
    expect(vcsBranches).toHaveBeenLastCalledWith("/project-a");
    await vi.dynamicImportSettled();
  });
});
