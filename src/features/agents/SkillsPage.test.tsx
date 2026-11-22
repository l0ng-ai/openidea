import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentSkillMode, AgentSkillSource, AgentSkillState, McpScope, ProjectInfo } from "@/bindings";
import { useProject } from "@/platform/project";
import { SkillsPage, type SkillsBackend } from "./SkillsPage";

const state = (
  name: string,
  source: AgentSkillSource,
  mode: AgentSkillMode = "auto",
  partial: Partial<AgentSkillState["skill"]> = {},
): AgentSkillState => ({
  skill: {
    name,
    description: `${name} helps with ${name} things`,
    path: `/skills/${name}`,
    source,
    valid: true,
    warnings: [],
    ...partial,
  },
  mode,
  origin: mode === "off" ? "user" : mode === "slashOnly" ? "workspace" : "none",
});

const SKILLS: AgentSkillState[] = [
  state("tdd", "workspace"),
  state("impeccable", "user", "off"),
  state("ux-flow", "claudeWorkspace", "slashOnly"),
  state("playwright", "copilotUser"),
];

function backend(): SkillsBackend & { setModeCalls: Array<{ name: string; scope: McpScope; mode: AgentSkillMode }> } {
  const setModeCalls: Array<{ name: string; scope: McpScope; mode: AgentSkillMode }> = [];
  return {
    setModeCalls,
    list: vi.fn(async () => SKILLS),
    setMode: vi.fn(async (name: string, scope: McpScope, mode: AgentSkillMode) => {
      setModeCalls.push({ name, scope, mode });
      return SKILLS.map((s) => (s.skill.name === name ? { ...s, mode } : s));
    }),
  };
}

/** Opens one row's select and picks an option by text. */
function pick(triggerLabel: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: triggerLabel }));
  fireEvent.click(within(screen.getByRole("listbox")).getByText(option));
}

afterEach(() => useProject.setState({ project: null }));

describe("SkillsPage", () => {
  it("groups skills by source with their mode and validation tags", async () => {
    render(<SkillsPage backend={backend()} />);

    await waitFor(() => expect(screen.getByText("tdd")).toBeInTheDocument());
    const workspace = screen.getByRole("region", { name: "Workspace" });
    expect(within(workspace).getByText("tdd")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "User" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "GitHub Copilot" })).toBeInTheDocument();
    expect(screen.getAllByText("Slash only").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Mode for impeccable" })).toHaveTextContent("Off");
    expect(screen.queryByText("Valid")).not.toBeInTheDocument();
  });

  it("filters skills by search", async () => {
    render(<SkillsPage backend={backend()} />);

    await waitFor(() => expect(screen.getByText("tdd")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("Type to search..."), { target: { value: "playwright" } });
    expect(screen.getByText("playwright")).toBeInTheDocument();
    expect(screen.queryByText("tdd")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "GitHub Copilot" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Workspace" })).not.toBeInTheDocument();
  });

  it("limits the list to the chosen source tab", async () => {
    render(<SkillsPage backend={backend()} />);

    await waitFor(() => expect(screen.getByText("tdd")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: /Agent Folders/ }));
    expect(screen.getByText("playwright")).toBeInTheDocument();
    expect(screen.queryByText("tdd")).not.toBeInTheDocument();
    expect(screen.queryByText("impeccable")).not.toBeInTheDocument();
  });

  it("sets a skill's mode in Global from its row", async () => {
    const backendSpy = backend();
    render(<SkillsPage backend={backendSpy} />);

    await waitFor(() => expect(screen.getByText("tdd")).toBeInTheDocument());
    pick("Mode for tdd", "Off");
    await waitFor(() => expect(backendSpy.setModeCalls).toEqual([{ name: "tdd", scope: "user", mode: "off" }]));
    await waitFor(() => expect(screen.getByRole("button", { name: "Mode for tdd" })).toHaveTextContent("Off"));
  });

  it("sets a skill's mode in the workspace scope", async () => {
    const project = { root: "/proj", name: "Proj", trusted: true, isGit: true } as ProjectInfo;
    useProject.setState({ project });
    const backendSpy = backend();
    render(<SkillsPage backend={backendSpy} />);

    await waitFor(() => expect(screen.getByText("tdd")).toBeInTheDocument());
    pick("Scope for tdd", "Workspace");
    pick("Mode for tdd", "Slash only");
    await waitFor(() =>
      expect(backendSpy.setModeCalls).toEqual([{ name: "tdd", scope: "workspace", mode: "slashOnly" }]),
    );
  });

  it("expands a row to its canonical path, collapsed symlink sources, validation result, and open action", async () => {
    const withSymlink = [state("tdd", "workspace", "auto", { alsoIn: ["claudeWorkspace"] }), ...SKILLS.slice(1)];
    render(<SkillsPage backend={{ list: vi.fn(async () => withSymlink), setMode: vi.fn(async () => withSymlink) }} />);

    await waitFor(() => expect(screen.getByText("tdd")).toBeInTheDocument());
    expect(screen.getByTitle(".claude/skills")).toHaveTextContent("Claude Code");
    fireEvent.click(screen.getByRole("button", { name: /^tdd/ }));
    expect(await screen.findByText("/skills/tdd")).toBeInTheDocument();
    expect(screen.getByText("Claude Code (.claude/skills)")).toBeInTheDocument();
    expect(screen.getByText("SKILL.md is valid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open SKILL.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy the path of tdd" })).toBeInTheDocument();
  });

  it("surfaces validation warnings of an invalid SKILL.md", async () => {
    const invalid = [
      state("broken", "workspace", "auto", {
        valid: false,
        warnings: ["the frontmatter name does not match the folder"],
      }),
    ];
    render(<SkillsPage backend={{ list: vi.fn(async () => invalid), setMode: vi.fn(async () => invalid) }} />);

    await waitFor(() => expect(screen.getByText("broken")).toBeInTheDocument());
    expect(screen.getByText("Invalid SKILL.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^broken/ }));
    expect(await screen.findByText(/does not match the folder/)).toBeInTheDocument();
    expect(screen.queryByText("SKILL.md is valid")).not.toBeInTheDocument();
  });
});
