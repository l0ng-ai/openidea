/**
 * Generate Commit Message with Agent: the coding agent the user works with reads the
 * changes about to be committed and writes their message. It runs as a short task that
 * is deleted once the message is in the commit field.
 */
import type {
  AgentConfigChoice,
  AgentConfigOption,
  AgentEntry,
  AgentModelCatalog,
  AgentProvider,
  AgentTask,
} from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import { maybeCommitService, notifications, type NotificationService } from "@/workbench/contributions";
import { REGISTRY_PAGE, isBusy } from "./model";
import { modeIcon, modeOption } from "./composerModel";
import { cancelTask, deleteTask, draftConfig, runQuietly, useAgents, type Draft } from "./store";

const PATCH_BUDGET = 48_000;
const FILE_BUDGET = 8_000;
const RECENT_SUBJECTS = 5;
const TIMEOUT_MS = 180_000;
const NOTIFICATION_KEY = "agents.commitMessage";

/**
 * `patch` within `budget` characters: files too long for `perFile` keep their beginning,
 * and the files that no longer fit are listed by name.
 */
export function fitPatch(patch: string, budget = PATCH_BUDGET, perFile = FILE_BUDGET): string {
  if (patch.length <= budget) return patch;
  let left = budget;
  let out = "";
  const omitted: string[] = [];
  for (const file of patch.split(/^(?=diff --git )/m)) {
    const head = file.split("\n", 1)[0]!;
    if (file.length <= perFile && file.length <= left) {
      out += file;
      left -= file.length;
    } else if (left >= 1_000) {
      const part = file.slice(0, Math.min(perFile, left)).replace(/\n[^\n]*$/, "");
      out += `${part}\n… (rest of this file's diff omitted)\n`;
      left -= part.length;
    } else {
      omitted.push(/ b\/(.*)$/.exec(head)?.[1] ?? head);
    }
  }
  return omitted.length ? `${out}\nDiff omitted for: ${omitted.join(", ")}\n` : out;
}

export function commitMessagePrompt(
  patch: string,
  subjectLimit: number,
  recentSubjects: readonly string[],
  instructions = "",
): string {
  const lines = [
    "Write a commit message",
    "",
    "Write the commit message for the changes below, which are about to be committed:",
    `- A subject line of at most ${subjectLimit} characters, in the imperative mood ("Add …", "Fix …"), without a trailing period.`,
    "- Only when the subject can't say it all: a blank line and a short body on what changed and why.",
    "- Don't edit files or run commands. The whole diff is below.",
    "- Reply with the commit message only: no quotes, no code fence, no commentary.",
  ];
  // The project's own conventions (Settings › Version Control › Commit) come before the style of recent commits.
  if (instructions.trim()) lines.push("", "Follow these conventions for commit messages here:", instructions.trim());
  if (recentSubjects.length) {
    lines.push(
      "",
      "Subjects of the latest commits here, for the style to follow:",
      ...recentSubjects.map((s) => `- ${s}`),
    );
  }
  lines.push("", "<changes>", fitPatch(patch).trimEnd(), "</changes>");
  return lines.join("\n");
}

/** The commit message in an agent's reply, without the quotes, fence or label it may have wrapped around it. */
export function commitMessageOf(reply: string): string {
  let text = reply.replace(/\r\n?/g, "\n").trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```/m.exec(text);
  if (fenced) text = fenced[1]!.trim();
  text = text.replace(/^commit message\s*:\s*/i, "");
  const quote = text[0];
  if (text.length > 1 && (quote === '"' || quote === "'" || quote === "`") && text.endsWith(quote)) {
    text = text.slice(1, -1);
  }
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The agent's answer to the last message: its final reply. */
export function replyOf(entries: readonly AgentEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "user") break;
    if (entry.type === "agent" && entry.text.trim()) return entry.text;
  }
  return "";
}

export interface CommitAgent {
  provider: string;
  config: AgentConfigChoice[];
}

/** The model of `options` as a choice for a new task, when it is one the agent offers. */
function modelChoice(options: readonly AgentConfigOption[]): AgentConfigChoice[] {
  const model = options.find((o) => o.category === "model");
  return model?.current && model.values.some((v) => v.value === model.current)
    ? [{ id: model.id, value: model.current }]
    : [];
}

/**
 * The settings that keep the agent read-only, or else make it ask before it edits or runs anything. New tasks start
 * in the mode that approves everything unless the user chose otherwise, and the changes
 * the agent reads here are text from the repository: they must not be able to run commands.
 */
export function askingChoices(options: readonly AgentConfigOption[]): AgentConfigChoice[] {
  const out: AgentConfigChoice[] = [];
  const mode = modeOption(options);
  if (mode) {
    const asking = mode.values.filter((v) => ["lock", "eye"].includes(modeIcon(v.value)));
    const value =
      asking.find((v) => /read-?only/i.test(v.value)) ??
      ["default", "ask"].map((p) => asking.find((v) => v.value === p)).find(Boolean) ??
      asking[0];
    if (value) out.push({ id: mode.id, value: value.value });
  }
  const permissions = options.find((o) => o.category === "permissions");
  const off = permissions?.values.find((v) => /^(off|false)$/i.test(v.value));
  if (permissions && off) out.push({ id: permissions.id, value: off.value });
  const approval = options.find((o) => o.category === "approval");
  if (approval?.values.some((v) => v.value === "ask")) out.push({ id: approval.id, value: "ask" });
  return out;
}

const choicesFor = (options: readonly AgentConfigOption[]) => [...modelChoice(options), ...askingChoices(options)];

/** Settings › Version Control › Commit: the agent, model and thinking level to generate with; empty follows the agent. */
export interface CommitAgentPreference {
  agent: string;
  agentModel: string;
  agentEffort: string;
}

type ModelCatalog = Pick<AgentModelCatalog, "config" | "thoughtLevels">;

/**
 * The agent that wrote the code: the one of the project's latest task, on the model it
 * ran with. Without a task, the one the New Task page has selected. An agent chosen in
 * the settings replaces it, on the model and thinking level chosen there when it offers them.
 */
export function pickAgent(
  tasks: Iterable<AgentTask>,
  providers: readonly AgentProvider[],
  draft: Draft,
  preference?: CommitAgentPreference,
  catalogs?: ReadonlyMap<string, ModelCatalog>,
): CommitAgent | null {
  const installed = providers.filter((p) => p.installed);
  const chosen = preference?.agent ? installed.find((p) => p.id === preference.agent) : undefined;
  const candidates = chosen ? [chosen] : installed;
  const latest = [...tasks]
    .filter((t) => t.status !== "archived" && candidates.some((p) => p.id === t.provider))
    .sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0))[0];
  const provider = latest
    ? installed.find((p) => p.id === latest.provider)!
    : (chosen ?? installed.find((p) => p.id === draft.provider) ?? installed[0]);
  if (!provider) return null;
  const options = latest
    ? latest.config
    : provider.id === draft.provider
      ? draftConfig(provider, draft)
      : provider.config;
  if (!chosen || !preference || (!preference.agentModel && !preference.agentEffort)) {
    return { provider: provider.id, config: choicesFor(options) };
  }
  return {
    provider: provider.id,
    config: [...preferredModel(options, provider, preference, catalogs?.get(provider.id)), ...askingChoices(options)],
  };
}

/** The model and thinking level of `preference` that the agent offers, else the ones it would run with. */
function preferredModel(
  options: readonly AgentConfigOption[],
  provider: AgentProvider,
  preference: CommitAgentPreference,
  catalog: ModelCatalog | undefined,
): AgentConfigChoice[] {
  const offered = (catalog?.config ?? provider.config).find((o) => o.category === "model");
  const fallback = modelChoice(options);
  const model =
    offered && preference.agentModel && offered.values.some((v) => v.value === preference.agentModel)
      ? { id: offered.id, value: preference.agentModel }
      : fallback[0];
  if (!model) return [];
  const levels = (catalog?.thoughtLevels ?? provider.thoughtLevels)?.[model.value] ?? [];
  const level = levels.find((o) => o.category === "thought_level");
  const effort =
    level && preference.agentEffort && level.values.some((v) => v.value === preference.agentEffort)
      ? [{ id: level.id, value: preference.agentEffort }]
      : [];
  return [model, ...effort];
}

/** Resolves when the task's turn ends; rejects when it can't produce an answer. */
function turnEnd(task: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = useAgents.subscribe(check);
    const timer = setTimeout(() => settle(tx("The agent did not answer in time")), TIMEOUT_MS);
    function settle(error?: string) {
      off();
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(new Error(error));
    }
    function check() {
      const current = useAgents.getState().tasks.get(task);
      if (!current) return settle(tx("The agent task was removed"));
      switch (current.status) {
        case "ready":
          return settle();
        case "failed":
          return settle(current.error ?? tx("The agent stopped"));
        case "limited":
          return settle(tx("The agent's usage limit was reached"));
        case "needsInput":
          return settle(tx("The agent asked for permission to continue"));
        case "archived":
          return settle(tx("The agent task was archived"));
      }
    }
    check();
  });
}

async function recentSubjects(repo: string | undefined): Promise<string[]> {
  try {
    const commits = await call(
      commands.vcsLog(repo ?? null, {
        branch: "HEAD",
        path: null,
        author: null,
        text: null,
        range: null,
        skip: 0,
        limit: RECENT_SUBJECTS,
      }),
    );
    return commits.map((c) => c.summary).filter(Boolean);
  } catch {
    return [];
  }
}

function notify(n: Omit<Parameters<NotificationService["notify"]>[0], "key" | "group" | "userInitiated">) {
  notifications().notify({ ...n, key: NOTIFICATION_KEY, group: "vcs", userInitiated: true });
}

let running = false;

/** Asks the agent for the message of the commit being prepared and puts it in the commit field. */
export async function generateCommitMessage(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await generate();
  } finally {
    running = false;
  }
}

async function generate(): Promise<void> {
  const service = maybeCommitService();
  if (!service) return;
  let changes;
  try {
    changes = await service.changes();
  } catch (e) {
    notify({ level: "error", title: "Couldn't read the changes", body: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (!changes) return;
  if (!changes.patch.trim()) {
    notify({ level: "info", title: "No changes to describe", body: "Include changes in the commit first." });
    return;
  }
  const { commit } = workflowSettings().vcs;
  const { tasks, providers, draft, modelCatalogs } = useAgents.getState();
  const agent = pickAgent(tasks.values(), providers, draft, commit, modelCatalogs);
  if (!agent) {
    notify({
      level: "warning",
      title: "No coding agent available",
      body: "Set one up in Settings › Agents. Agents don't run in projects you haven't trusted.",
      actions: [{ label: "Open Settings", run: () => void executeAction("file.settings", REGISTRY_PAGE) }],
    });
    return;
  }

  const subjects = await recentSubjects(changes.roots[0]);
  const prompt = commitMessagePrompt(
    changes.patch,
    commit.limitSubject ? commit.subjectLimit : 72,
    subjects,
    commit.agentInstructions,
  );
  let task: AgentTask | undefined;
  let release = () => {};
  try {
    const created = await call(
      commands.agentCreate({
        projectRoot: null,
        prompt: { text: prompt, files: [], images: [] },
        provider: agent.provider,
        config: agent.config,
        isolation: "local",
        base: null,
      }),
    );
    task = created;
    release = runQuietly(created.id);
    // Its events can arrive before this reply: keep the newer state they carried.
    useAgents.setState((s) => ({
      tasks: s.tasks.has(created.id) ? s.tasks : new Map(s.tasks).set(created.id, created),
    }));
    await turnEnd(created.id);
    const message = commitMessageOf(replyOf(await call(commands.agentEntries(created.id, null))));
    if (!message) throw new Error(tx("The agent did not reply with a commit message"));
    // The files may have been edited since without touching the draft: the message must
    // still describe what would be committed.
    const unchanged = async () => {
      if (service.revision() !== changes.revision) return null;
      const now = await service.changes().catch(() => null);
      return now && now.patch === changes.patch ? now.revision : null;
    };
    const at = await unchanged();
    if (at === null || !service.setMessage(at, message)) {
      notify({
        level: "info",
        title: "Commit message not replaced",
        body: "The message or the included changes were edited meanwhile.",
      });
    }
  } catch (e) {
    notify({
      level: "error",
      title: "Couldn't generate the commit message",
      body: e instanceof Error ? e.message : String(e),
    });
  } finally {
    if (task) {
      const status = useAgents.getState().tasks.get(task.id)?.status;
      if (status && isBusy(status)) await cancelTask(task.id).catch(() => {});
      await deleteTask(task.id, false).catch(() => {});
    }
    release();
  }
}
