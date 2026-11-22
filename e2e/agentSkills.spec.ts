import type { AgentEntry, AgentProvider, AgentSkillMode, AgentSkillState, AgentTask } from "../src/bindings";
import { expect, ipcCalls, stubDesktop, test } from "./fixtures";

const claudeProvider: AgentProvider = {
  id: "claude",
  name: "Claude Code",
  command: "claude",
  program: "claude",
  args: [],
  defaultProgram: "claude",
  defaultArgs: [],
  loginHint: null,
  commandOverridden: false,
  commandEditable: true,
  commandReadOnlyReason: null,
  installed: true,
  env: {},
  commands: [],
  source: { kind: "builtin" },
  config: [
    {
      id: "model",
      category: "model",
      name: "Model",
      description: null,
      current: "claude-sonnet-4.6",
      via: "option",
      values: [{ value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", description: null }],
    },
    {
      id: "mode",
      category: "mode",
      name: "Mode",
      description: null,
      current: "default",
      via: "option",
      values: [{ value: "default", name: "Default", description: null }],
    },
  ],
  thoughtLevels: {},
};

const sampleTask: AgentTask = {
  id: "skills-session-1",
  title: "Verify Composer and Settings skill overrides",
  provider: "claude",
  status: "ready",
  isolation: "local",
  model: "claude-sonnet-4.6",
  cwd: "/dev/openidea",
  branch: "main",
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 0,
  config: claudeProvider.config,
  commands: [],
  usage: null,
  queue: [],
  mcpOverrides: {},
  skillOverrides: {},
};

const initialSkills: AgentSkillState[] = [
  {
    skill: {
      name: "verify",
      description: "Build, launch and drive OpenIDEA through the Tauri MCP bridge",
      hint: "[flow]",
      path: "/dev/openidea/.agents/skills/verify",
      source: "workspace",
      alsoIn: ["claudeWorkspace"],
      userInvocable: true,
      disableModelInvocation: false,
      valid: true,
      warnings: [],
    },
    mode: "auto",
    origin: "none",
  },
  {
    skill: {
      name: "issue-fix",
      description: "Reproduce, sweep sibling defect classes, verify, and open one PR",
      hint: "<issue>",
      path: "/dev/openidea/.agents/skills/issue-fix",
      source: "workspace",
      alsoIn: ["claudeWorkspace"],
      userInvocable: true,
      disableModelInvocation: true,
      valid: true,
      warnings: [],
    },
    mode: "slashOnly",
    origin: "none",
  },
  {
    skill: {
      name: "impeccable",
      description: "Muted globally in settings.toml; can be enabled for one session",
      hint: null,
      path: "/Users/dev/.agents/skills/impeccable",
      source: "user",
      alsoIn: [],
      userInvocable: true,
      disableModelInvocation: false,
      valid: true,
      warnings: [],
    },
    mode: "off",
    origin: "user",
  },
  {
    skill: {
      name: "pg-tune",
      description: "Tune PostgreSQL queries from 2-level Copilot marketplace plugin",
      hint: null,
      path: "/Users/dev/.copilot/installed-plugins/awesome-copilot/db-tools/skills/pg-tune",
      source: "copilotUser",
      alsoIn: [],
      userInvocable: true,
      disableModelInvocation: false,
      valid: true,
      warnings: [],
    },
    mode: "auto",
    origin: "none",
  },
  {
    skill: {
      name: "repo-untrusted",
      description: "Locked off while workspace is untrusted",
      hint: null,
      path: "/dev/untrusted/.agents/skills/repo-untrusted",
      source: "workspace",
      alsoIn: [],
      userInvocable: true,
      disableModelInvocation: false,
      valid: true,
      warnings: [],
    },
    mode: "off",
    origin: "trust",
  },
];

test("manages multi-level skills in Settings and per-session overrides via Composer /skills", async ({
  workbench: page,
}) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await stubDesktop(page);

  await page.evaluate(
    async ({ claudeProvider, sampleTask, initialSkills }) => {
      const storeModule = "/src/features/agents/store.ts";
      const store = await import(/* @vite-ignore */ storeModule);

      let skills = structuredClone(initialSkills);
      let currentTask = structuredClone(sampleTask);
      const entries: AgentEntry[] = [
        { type: "user", text: "Audit the skills hub Phase 1 edge cases.", attachments: [] },
        { type: "agent", text: "Ready — select session skills or inspect Settings › Agents › Skills." },
      ];

      const handlers = window.__ipc.handlers;
      handlers.agent_subscribe = () => [currentTask];
      handlers.agent_providers = () => [claudeProvider];
      handlers.agent_refresh_models = () => ({
        provider: claudeProvider.id,
        config: claudeProvider.config,
        thoughtLevels: {},
        refreshing: false,
        refreshedAtMs: Date.now(),
        retryAtMs: null,
        error: null,
      });
      handlers.agent_probe = () => null;
      handlers.agent_entries = () => entries;
      handlers.agent_changes = () => [];
      handlers.agent_grouped_changes = () => ({ uncommitted: [], commits: [] });
      handlers.vcs_branch_info = () => ({ head: "main" });
      handlers.vcs_branches = () => [];
      handlers.agent_skills_list = () => skills;
      handlers.agent_skills_set_mode = ({ name, scope, mode }) => {
        skills = skills.map((s) =>
          s.skill.name === name
            ? { ...s, mode: mode as AgentSkillMode, origin: scope === "workspace" ? "workspace" : "user" }
            : s,
        );
        return skills;
      };
      handlers.agent_set_skill_overrides = ({ overrides }) => {
        currentTask = { ...currentTask, skillOverrides: overrides as Record<string, AgentSkillMode> };
        return currentTask;
      };
      handlers.agent_commands = () => {
        const overrides = currentTask.skillOverrides ?? {};
        return skills
          .filter((s) => {
            if (s.origin === "trust") return false;
            const effective = overrides[s.skill.name] ?? s.mode;
            return effective !== "off" && s.skill.userInvocable !== false;
          })
          .map((s) => ({
            name: s.skill.name,
            description: s.skill.description,
            hint: s.skill.hint ?? null,
            source: "skill" as const,
          }));
      };

      await store.connect();
      store.openTask(currentTask.id);
    },
    { claudeProvider, sampleTask, initialSkills },
  );

  const composerBox = page.getByRole("textbox", { name: "Message" });
  await expect(composerBox).toBeVisible();
  await composerBox.click();
  await page.keyboard.type("/sk");
  await expect(page.getByRole("listbox", { name: "Commands" })).toContainText("/skills");
  await page.keyboard.press("Enter");

  const sessionPopup = page.getByRole("dialog", { name: "Session Skills" });
  await expect(sessionPopup).toBeVisible();
  await expect(sessionPopup).toContainText("verify");
  await expect(sessionPopup).toContainText("impeccable");
  await expect(sessionPopup).toContainText("Untrusted workspace");

  // Enable default-off `impeccable` for this session and turn `pg-tune` off for this session.
  await sessionPopup.getByRole("switch", { name: "Enable impeccable for this session" }).click();
  await sessionPopup.getByRole("switch", { name: "Enable pg-tune for this session" }).click();
  const overrideCalls = await ipcCalls(page, "agent_set_skill_overrides");
  expect(overrideCalls.at(-1)?.overrides).toEqual({ impeccable: "auto", "pg-tune": "off" });

  const screenshotDir = process.env.CAPTURE_SKILLS_SCREENSHOTS;
  if (screenshotDir) {
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${screenshotDir}/after-session-picker.png` });
  }

  await sessionPopup.getByRole("button", { name: "Reset" }).click();
  await expect(sessionPopup.getByRole("button", { name: "Reset" })).toHaveCount(0);

  // Jump from `Skills…` gear icon to Settings › Agents › Skills.
  await sessionPopup.getByRole("button", { name: "Skills…" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settingsDialog).toBeVisible();
  await expect(settingsDialog.getByRole("heading", { name: "Skills" })).toBeVisible();
  await expect(settingsDialog.getByTitle(".claude/skills").first()).toHaveText("Claude Code");

  await settingsDialog.getByRole("button", { name: /^verify/ }).click();
  await expect(settingsDialog.getByText("Claude Code (.claude/skills)")).toBeVisible();
  await expect(settingsDialog.getByText("SKILL.md is valid")).toBeVisible();

  if (screenshotDir) {
    await settingsDialog.screenshot({ path: `${screenshotDir}/after-settings-skills.png` });
  }
});
