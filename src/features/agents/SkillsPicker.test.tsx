import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentSkillMode, AgentSkillSource, AgentSkillState } from "@/bindings";
import { SkillsPicker } from "./SkillsPicker";
import type { SkillsBackend } from "./skillsModel";

const state = (name: string, source: AgentSkillSource, mode: AgentSkillMode): AgentSkillState => ({
  skill: {
    name,
    description: `${name} helps with ${name} things`,
    path: `/skills/${name}`,
    source,
    valid: true,
    warnings: [],
  },
  mode,
  origin: mode === "off" ? "user" : "none",
});

const SKILLS: AgentSkillState[] = [
  state("tdd", "workspace", "auto"),
  state("verify", "workspace", "slashOnly"),
  state("impeccable", "user", "off"),
  state("playwright", "copilotUser", "auto"),
];

function Harness({
  provider = "copilot",
  backend,
  skills = SKILLS,
}: {
  provider?: string;
  backend?: SkillsBackend;
  skills?: AgentSkillState[];
}) {
  const [overrides, setOverrides] = useState<Record<string, AgentSkillMode>>({});
  return (
    <SkillsPicker
      provider={provider}
      overrides={overrides}
      onChange={setOverrides}
      backend={backend}
      testData={{ skills }}
    />
  );
}

describe("SkillsPicker", () => {
  it("shows active counts, groups skills by source, and marks slash-only modes", async () => {
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "Skills" });
    expect(trigger).toHaveTextContent("Skills3/4");

    fireEvent.click(trigger);
    expect(await screen.findByText("Session Skills")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getByText("GitHub Copilot")).toBeInTheDocument();
    expect(screen.getByText("/Slash")).toBeInTheDocument();
    expect(screen.getByText("playwright helps with playwright things")).toBeInTheDocument();
  });

  it("turns a skill off for the session, shows the Session pill, and resets", async () => {
    const backend: SkillsBackend = { list: vi.fn(async () => SKILLS), setMode: vi.fn(async () => SKILLS) };
    render(<Harness backend={backend} />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    const playwright = await screen.findByRole("switch", { name: "Enable playwright for this session" });
    expect(playwright).toHaveAttribute("aria-checked", "true");

    fireEvent.click(playwright);
    await waitFor(() => expect(screen.getByRole("button", { name: "Skills" })).toHaveTextContent("Skills2/4"));
    expect(screen.getAllByText("Session")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Skills" })).toHaveTextContent("Skills3/4"));
    expect(screen.queryByText("Session")).not.toBeInTheDocument();
  });

  it("enables a default-off skill for this session only while keeping untrusted workspace skills locked", async () => {
    const withUntrusted: AgentSkillState[] = [
      ...SKILLS,
      {
        skill: {
          name: "repo-script",
          description: "Untrusted workspace skill",
          path: "/repo/.agents/skills/repo-script",
          source: "workspace",
          valid: true,
          warnings: [],
        },
        mode: "off",
        origin: "trust",
      },
    ];
    render(<Harness skills={withUntrusted} />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    const impeccable = await screen.findByRole("switch", { name: "Enable impeccable for this session" });
    expect(impeccable).toHaveAttribute("aria-checked", "false");
    fireEvent.click(impeccable);
    await waitFor(() => expect(screen.getByRole("button", { name: "Skills" })).toHaveTextContent("Skills4/5"));
    expect(screen.getAllByText("Session")).toHaveLength(1);

    // Untrusted workspace skill stays locked and cannot be turned on via session override.
    expect(screen.queryByRole("switch", { name: "Enable repo-script for this session" })).not.toBeInTheDocument();
    expect(screen.getByText("Untrusted workspace")).toBeInTheDocument();
  });

  it("brings a session-off skill back with its toggle", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    const tdd = await screen.findByRole("switch", { name: "Enable tdd for this session" });
    fireEvent.click(tdd);
    expect(screen.getByRole("button", { name: "Skills" })).toHaveTextContent("Skills2/4");
    fireEvent.click(tdd);
    expect(screen.getByRole("button", { name: "Skills" })).toHaveTextContent("Skills3/4");
    expect(screen.queryByText("Session")).not.toBeInTheDocument();
  });

  it("filters skills by name, description, and path", async () => {
    const more = [...SKILLS, state("hex-review", "codexUser", "auto"), state("release-notes", "cursorUser", "auto")];
    render(<Harness skills={more} />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    fireEvent.change(await screen.findByPlaceholderText("Filter skills…"), { target: { value: "playwright" } });
    expect(screen.getByText("playwright")).toBeInTheDocument();
    expect(screen.queryByText("tdd")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Filter skills…"), { target: { value: "/skills/tdd" } });
    expect(screen.getByText("tdd")).toBeInTheDocument();
    expect(screen.queryByText("playwright")).not.toBeInTheDocument();
  });

  it("stays honest about ACP agents, whose / menu OpenIDEA only filters", async () => {
    render(<Harness provider="cursor-acp" />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(
      await screen.findByText("This agent keeps its own / menu: off only stops OpenIDEA offering the skill."),
    ).toBeInTheDocument();
  });

  it("says nothing special for non-ACP agents", async () => {
    render(<Harness provider="claude" />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(
      screen.queryByText("This agent keeps its own / menu: off only stops OpenIDEA offering the skill."),
    ).not.toBeInTheDocument();
  });

  it("groups plugin-contributed skills under Plugins and lets the session toggle them", async () => {
    const withPlugin = [...SKILLS, state("release-notes", "plugin", "auto")];
    render(<Harness skills={withPlugin} />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(await screen.findByText("Plugins")).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Enable release-notes for this session" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("button", { name: "Skills" })).toHaveTextContent("Skills3/5"));
  });

  it("shows fork and paths pills on skills with context: fork and paths frontmatter", async () => {
    const richSkills: AgentSkillState[] = [
      {
        skill: {
          name: "verify-ux",
          description: "Verify UX layouts",
          path: "/ws/.agents/skills/verify-ux",
          source: "workspace",
          contextFork: true,
          paths: ["src/**/*.tsx", "e2e/*.spec.ts"],
          valid: true,
          warnings: [],
        },
        mode: "auto",
        origin: "none",
      },
    ];
    render(<Harness skills={richSkills} />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(await screen.findByText("fork")).toBeInTheDocument();
    expect(screen.getByText("paths")).toBeInTheDocument();
    expect(screen.getByTitle("Verify UX layouts · src/**/*.tsx, e2e/*.spec.ts")).toBeInTheDocument();
  });

  it("shows an empty state without skills", async () => {
    render(<Harness skills={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(await screen.findByText("No skills found.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skills" })).toHaveTextContent("Skills0");
  });
});
