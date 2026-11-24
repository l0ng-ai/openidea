/**
 * Shared agent-skills model behind Settings › Agents › Skills and the composer Skills picker:
 * the discovered skills of every CLI with their resolved modes, and the per-session overrides
 * (`AgentTask.skill_overrides`) on top of them.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type {
  AgentSkillMode,
  AgentSkillSource,
  AgentSkillState,
  InstallRemoteSkillRequest,
  McpScope,
  RemoteSkillBrowseResult,
  RemoteSkillPreview,
  RequestId,
} from "@/bindings";
import { call, commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";

export interface SkillsBackend {
  list(): Promise<AgentSkillState[]>;
  setMode(name: string, scope: McpScope, mode: AgentSkillMode): Promise<AgentSkillState[]>;
  browse?(source: string, request: RequestId): Promise<RemoteSkillBrowseResult>;
  preview?(
    owner: string,
    repo: string,
    gitRef: string,
    subpath: string,
    request: RequestId,
  ): Promise<RemoteSkillPreview>;
  install?(input: InstallRemoteSkillRequest, request: RequestId): Promise<AgentSkillState[]>;
}

export const defaultSkillsBackend: SkillsBackend = {
  list: () => (typeof commands.agentSkillsList === "function" ? call(commands.agentSkillsList()) : Promise.resolve([])),
  setMode: (name, scope, mode) => call(commands.agentSkillsSetMode(name, scope, mode)),
  browse: (source, request) => call(commands.agentSkillsBrowse(source, request)),
  preview: (owner, repo, gitRef, subpath, request) =>
    call(commands.agentSkillsPreview(owner, repo, gitRef, subpath, request)),
  install: (input, request) => call(commands.agentSkillsInstall(input, request)),
};

/** Which folder family a skill came from, with the paths it is discovered in. */
export const SKILL_SOURCE_GROUPS: Record<AgentSkillSource, { label: string; paths: string; agent: string | null }> = {
  workspace: { label: "Workspace", paths: ".agents/skills · .openidea/skills", agent: null },
  user: { label: "User", paths: "~/.agents/skills", agent: null },
  plugin: { label: "Plugins", paths: "[[contributes.skills]]", agent: null },
  claudeWorkspace: { label: "Claude Code", paths: ".claude/skills", agent: "claude" },
  claudeUser: { label: "Claude Code", paths: "~/.claude/skills", agent: "claude" },
  githubWorkspace: { label: "GitHub Copilot", paths: ".github/skills", agent: "copilot" },
  copilotUser: { label: "GitHub Copilot", paths: "~/.copilot/skills · installed plugins", agent: "copilot" },
  codexWorkspace: { label: "Codex", paths: ".codex/skills", agent: "codex" },
  codexUser: { label: "Codex", paths: "~/.codex/skills", agent: "codex" },
  cursorWorkspace: { label: "Cursor", paths: ".cursor/skills", agent: "cursor" },
  cursorUser: { label: "Cursor", paths: "~/.cursor/skills", agent: "cursor" },
};

/** Skill folders the CLI discovers itself: OpenIDEA only reads them, and its "off" holds only where the CLI supports it. */
export function isDiscoveredSource(source: AgentSkillSource): boolean {
  return source !== "workspace" && source !== "user" && source !== "plugin";
}

export interface SessionSkillItem {
  name: string;
  state: AgentSkillState;
  /** The mode the settings resolve to for this session, before any override. */
  defaultMode: AgentSkillMode;
  /** Effective mode for this session after applying `overrides`. */
  mode: AgentSkillMode;
  /** True when `overrides` explicitly diverges from the resolved policy. */
  overridden: boolean;
  /** True when Workspace Trust locks this workspace skill off. */
  locked: boolean;
}

export interface ResolvedSessionSkills {
  groups: Array<{ source: AgentSkillSource; items: SessionSkillItem[] }>;
  activeCount: number;
  totalCount: number;
  overrideCount: number;
}

/** Resolves the session's skills: the discovered list with its modes, then the session's overrides. */
export function resolveSessionSkills(
  skills: readonly AgentSkillState[],
  overrides: Readonly<Record<string, AgentSkillMode>> = {},
): ResolvedSessionSkills {
  const items = skills.map<SessionSkillItem>((state) => {
    const locked = state.origin === "trust";
    const explicit = overrides[state.skill.name];
    const mode = locked ? "off" : (explicit ?? state.mode);
    return {
      name: state.skill.name,
      state,
      defaultMode: state.mode,
      mode,
      overridden: !locked && explicit !== undefined && explicit !== state.mode,
      locked,
    };
  });
  const groups: ResolvedSessionSkills["groups"] = [];
  const seen = new Set<AgentSkillSource>();
  for (const item of items) {
    if (seen.has(item.state.skill.source)) continue;
    seen.add(item.state.skill.source);
    groups.push({
      source: item.state.skill.source,
      items: items.filter((i) => i.state.skill.source === item.state.skill.source),
    });
  }
  const activeCount = items.filter((i) => i.mode !== "off").length;
  const overrideCount = items.filter((i) => i.overridden).length;
  return { groups, activeCount, totalCount: items.length, overrideCount };
}

/**
 * Computes the minimal `skillOverrides` map after toggling `name` for this session:
 * returning to the default policy deletes the override; turning a default-off skill on
 * overrides to `"auto"`, and turning an active skill off overrides to `"off"`.
 */
export function nextSkillOverrides(
  current: Readonly<Record<string, AgentSkillMode>> | undefined,
  item: Pick<SessionSkillItem, "name" | "defaultMode">,
  nextEnabled: boolean,
): Record<string, AgentSkillMode> {
  const next = { ...(current ?? {}) };
  const defaultEnabled = item.defaultMode !== "off";
  if (nextEnabled === defaultEnabled) {
    delete next[item.name];
  } else {
    next[item.name] = nextEnabled ? "auto" : "off";
  }
  return next;
}

/** Shared window-level cache of the skills every CLI exposes, with their resolved modes. */
interface SkillsCatalogState {
  skills: AgentSkillState[];
  loaded: boolean;
}

export const useSkillsCatalog = create<SkillsCatalogState>(() => ({
  skills: [],
  loaded: false,
}));

let listenerAttached = false;

export async function refreshSkillsCatalog(backend: SkillsBackend = defaultSkillsBackend): Promise<void> {
  if (!isTauri()) return;
  const skills = await backend.list().catch(() => null);
  if (skills) useSkillsCatalog.setState({ skills, loaded: true });
}

export function useSkillsCatalogSync(backend: SkillsBackend = defaultSkillsBackend): void {
  const root = useProject((s) => s.project?.root);
  useEffect(() => {
    if (!isTauri()) return;
    void refreshSkillsCatalog(backend);
    const onFocus = () => void refreshSkillsCatalog(backend);
    window.addEventListener("focus", onFocus);
    if (!listenerAttached && typeof onIdeEvent === "function") {
      listenerAttached = true;
      onIdeEvent("settingsChanged", (e) => {
        if (!e.key || e.key.startsWith("agents.skills")) {
          void refreshSkillsCatalog(backend);
        }
      });
    }
    return () => window.removeEventListener("focus", onFocus);
  }, [root, backend]);
}
