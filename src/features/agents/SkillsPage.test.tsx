import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  AgentSkillMode,
  AgentSkillSource,
  AgentSkillState,
  InstallRemoteSkillRequest,
  McpScope,
  ProjectInfo,
  RemoteSkillPreview,
} from "@/bindings";
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
  state("release-notes", "plugin"),
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
  fireEvent.click(within(screen.getByRole("listbox", { name: triggerLabel })).getByText(option));
}

afterEach(() => useProject.setState({ project: null }));

describe("SkillsPage", () => {
  it("groups skills by source with their mode and validation tags", async () => {
    render(<SkillsPage backend={backend()} />);

    await waitFor(() => expect(screen.getByText("tdd")).toBeInTheDocument());
    const workspace = screen.getByRole("region", { name: "Workspace" });
    expect(within(workspace).getByText("tdd")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "User" })).toBeInTheDocument();
    const plugins = screen.getByRole("region", { name: "Plugins" });
    expect(within(plugins).getByText("release-notes")).toBeInTheDocument();
    expect(within(plugins).queryByText("CLI-discovered")).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("tab", { name: /Plugins/ }));
    expect(screen.getByText("release-notes")).toBeInTheDocument();
    expect(screen.queryByText("tdd")).not.toBeInTheDocument();
    expect(screen.queryByText("playwright")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Agent Folders/ }));
    expect(screen.getByText("playwright")).toBeInTheDocument();
    expect(screen.queryByText("tdd")).not.toBeInTheDocument();
    expect(screen.queryByText("impeccable")).not.toBeInTheDocument();
    expect(screen.queryByText("release-notes")).not.toBeInTheDocument();
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

  it("browses a GitHub repo, previews SKILL.md & files, gates on static scan warnings, and installs", async () => {
    const project = { root: "/proj", name: "Proj", trusted: true, isGit: true } as ProjectInfo;
    useProject.setState({ project });

    const installCalls: InstallRemoteSkillRequest[] = [];
    const previews: Record<string, RemoteSkillPreview> = {
      "skills/clean-doc": {
        owner: "acme",
        repo: "skills",
        gitRef: "main",
        treeSha: "abc123",
        subpath: "skills/clean-doc",
        skillName: "clean-doc",
        description: "Clean documentation helper",
        skillMarkdown: "---\nname: clean-doc\ndescription: Clean documentation helper\n---\nWrite clear docs.\n",
        files: [{ path: "SKILL.md", size: 92, executable: false, symlink: false }],
        scanWarnings: [],
        alreadyInstalledUser: false,
        alreadyInstalledWorkspace: false,
      },
      "skills/deploy-script": {
        owner: "acme",
        repo: "skills",
        gitRef: "main",
        treeSha: "abc123",
        subpath: "skills/deploy-script",
        skillName: "deploy-script",
        description: "Deploys staging builds",
        skillMarkdown:
          "---\nname: deploy-script\ndescription: Deploys staging builds\nallowed-tools: Bash(git:*)\n---\nRun deploy.\n",
        files: [
          { path: "SKILL.md", size: 112, executable: false, symlink: false },
          { path: "scripts/deploy.sh", size: 48, executable: true, symlink: false },
        ],
        scanWarnings: [
          {
            kind: "executableScript",
            file: "scripts/deploy.sh",
            message: "Contains executable file mode (100755)",
          },
          {
            kind: "allowedToolsShell",
            file: "SKILL.md",
            message: "`allowed-tools` grants shell/command execution (`Bash(git:*)`)",
          },
        ],
        alreadyInstalledUser: false,
        alreadyInstalledWorkspace: false,
      },
    };

    const installerBackend: SkillsBackend = {
      ...backend(),
      browse: vi.fn(async () => ({
        owner: "acme",
        repo: "skills",
        gitRef: "main",
        treeSha: "abc123",
        truncated: false,
        skills: [
          { folderName: "clean-doc", subpath: "skills/clean-doc", fileCount: 1, totalBytes: 92 },
          { folderName: "deploy-script", subpath: "skills/deploy-script", fileCount: 2, totalBytes: 160 },
        ],
      })),
      preview: vi.fn(async (_owner, _repo, _ref, subpath) => {
        const found = previews[subpath];
        if (!found) throw new Error(`missing preview for ${subpath}`);
        return found;
      }),
      install: vi.fn(async (input) => {
        installCalls.push(input);
        return [...SKILLS, state("deploy-script", input.scope === "workspace" ? "workspace" : "user")];
      }),
    };

    render(<SkillsPage backend={installerBackend} />);
    await waitFor(() => expect(screen.getByText("tdd")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Install Skill…" }));
    const dialog = await screen.findByRole("dialog", { name: "Install Agent Skill" });
    fireEvent.change(within(dialog).getByLabelText("Skill repository"), { target: { value: "acme/skills" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Fetch" }));

    // First candidate (`clean-doc`) has 0 warnings -> Install is immediately enabled.
    expect(await within(dialog).findByText(/Static scan passed/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Install" })).toBeEnabled();

    // Switch to `deploy-script` -> warnings require confirmation checkbox before Install enables.
    fireEvent.click(within(dialog).getByRole("option", { name: /deploy-script/ }));
    expect(await within(dialog).findByText(/Static security scan found 2 warnings/)).toBeInTheDocument();
    const installBtn = within(dialog).getByRole("button", { name: "Install" });
    expect(installBtn).toBeDisabled();

    // Inspect bundled file list tab.
    fireEvent.click(within(dialog).getByRole("tab", { name: /Files \(2\)/ }));
    expect(within(dialog).getAllByText("scripts/deploy.sh")).toHaveLength(2);
    expect(within(dialog).getByText("Executable")).toBeInTheDocument();

    // Confirm warnings and install into Workspace (.agents/skills).
    pick("Install location", "Workspace (.agents/skills)");
    fireEvent.click(within(dialog).getByLabelText("I reviewed these warnings and want to install this skill"));
    expect(installBtn).toBeEnabled();
    fireEvent.click(installBtn);

    await waitFor(() =>
      expect(installCalls).toEqual([
        {
          owner: "acme",
          repo: "skills",
          gitRef: "main",
          subpath: "skills/deploy-script",
          scope: "workspace",
          confirmWarnings: true,
          overwrite: false,
        },
      ]),
    );
    await waitFor(() => expect(screen.getByText("deploy-script")).toBeInTheDocument());
  });

  it("displays context: fork and paths badges and expands paths in the inspector", async () => {
    const forked = [
      state("verify-ux", "workspace", "auto", {
        contextFork: true,
        paths: ["src/**/*.tsx", "e2e/*.spec.ts"],
      }),
    ];
    render(<SkillsPage backend={{ list: vi.fn(async () => forked), setMode: vi.fn(async () => forked) }} />);

    await waitFor(() => expect(screen.getByText("verify-ux")).toBeInTheDocument());
    expect(screen.getByText("context: fork")).toBeInTheDocument();
    expect(screen.getByText("paths (2)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^verify-ux/ }));
    expect(await screen.findByText("src/**/*.tsx, e2e/*.spec.ts")).toBeInTheDocument();
  });
});
