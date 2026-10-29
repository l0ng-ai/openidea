import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentCommand, AgentProvider } from "@/bindings";

const agentCommands = vi.fn();
const agentCreate = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      agentCommands: (provider: string, task: string | null) => agentCommands(provider, task),
      agentCreate: (request: unknown) => agentCreate(request),
      vcsBranches: () => Promise.resolve({ status: "ok", data: [] }),
    },
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

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
  agentCommands.mockReset();
  agentCreate.mockReset().mockResolvedValue({ status: "error", error: { kind: "invalid", message: "stop here" } });
  useAgents.setState({
    providers: [claude],
    draft: { provider: "claude", config: {}, isolation: "local", base: null },
  });
  updateComposer(HOME, emptyDraft());
});

describe("New Task composer commands", () => {
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
