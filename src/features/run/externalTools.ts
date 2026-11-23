/**
 * Settings › Tools › External Tools: every enabled tool is an action
 * (`externalTools.<id>`, category = its group) that expands IDEA macros
 * (`$FilePath$`, `$ProjectFileDir$`…) and runs in the Run tool window.
 */
import { activeEditor } from "@/editor/api";
import { executeAction, registerActions, type Action } from "@/platform/actions";
import { splitCommandLine } from "@/platform/commandLine";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { onWorkflowSettingsChange, workflowSettings, type ExternalToolValid } from "@/platform/workflowSettings";
import { isVirtualUri } from "@/platform/virtualDocs";
import { notifications, projectViewContextLead } from "@/workbench/contributions";
import { promptValue } from "./dialogs";
import { startRun, useRun } from "./store";

export interface MacroContext {
  projectRoot: string;
  projectName: string;
  filePath: string | null;
  line: number | null;
  column: number | null;
  selectedText: string;
}

const MACRO_RE = /\$([A-Za-z]+)\$/g;

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "";
}

/** Value of one macro, or `undefined` for unknown macros (left as typed). */
export function macroValue(name: string, ctx: MacroContext): string | undefined {
  const file = ctx.filePath;
  const dir = file ? file.slice(0, Math.max(file.lastIndexOf("/"), 0)) || "/" : "";
  const base = file ? file.slice(file.lastIndexOf("/") + 1) : "";
  const rel = (p: string) =>
    p === ctx.projectRoot ? "" : p.startsWith(ctx.projectRoot + "/") ? p.slice(ctx.projectRoot.length + 1) : p;
  switch (name) {
    case "FilePath":
      return file ?? "";
    case "FileDir":
      return dir;
    case "FileName":
      return base;
    case "FileNameWithoutExtension": {
      const ext = extOf(base);
      return ext ? base.slice(0, -ext.length - 1) : base;
    }
    case "FileExt":
      return extOf(base);
    case "FileRelativePath":
      return file ? rel(file) : "";
    case "FileDirRelativeToProjectRoot":
      return file ? rel(dir) : "";
    case "ProjectFileDir":
      return ctx.projectRoot;
    case "ProjectName":
      return ctx.projectName;
    case "LineNumber":
      return ctx.line === null ? "" : String(ctx.line);
    case "ColumnNumber":
      return ctx.column === null ? "" : String(ctx.column);
    case "SelectedText":
      return ctx.selectedText;
    default:
      return undefined;
  }
}

/** Expands macros in `text`; `$Prompt$` takes `prompt`. */
export function expandMacros(text: string, ctx: MacroContext, prompt = ""): string {
  return text.replace(MACRO_RE, (all, name: string) => (name === "Prompt" ? prompt : (macroValue(name, ctx) ?? all)));
}

/**
 * The file macros resolve against, as IDEA's data context: the Project view's file while the
 * tree is the user's context (it hands the context back on editor focus or a tab switch), else
 * the editor's file.
 */
function contextFile(editorPath: string | null): string | null {
  const lead = projectViewContextLead();
  if (lead && !lead.dir && !isVirtualUri(lead.path)) return lead.path;
  return editorPath;
}

function currentContext(): MacroContext | null {
  const project = useProject.getState().project;
  if (!project) return null;
  const ed = activeEditor();
  const filePath = contextFile(ed?.ctx.path ?? null);
  let line: number | null = null;
  let column: number | null = null;
  let selectedText = "";
  // The caret macros describe the editor, so only when it shows the file the macros use.
  if (ed && ed.ctx.path === filePath) {
    const state = ed.view.state;
    const sel = state.selection.main;
    const l = state.doc.lineAt(sel.head);
    line = l.number;
    column = sel.head - l.from + 1;
    selectedText = state.sliceDoc(sel.from, sel.to);
  }
  return {
    projectRoot: project.root,
    projectName: project.name,
    filePath,
    line,
    column,
    selectedText,
  };
}

/** The run configuration a tool expands to (no `$Prompt$` handling). */
export function toolRunConfig(tool: ExternalToolValid, ctx: MacroContext, prompt = ""): RunConfig {
  const program = expandMacros(tool.program.trim(), ctx, prompt);
  const args = splitCommandLine(tool.arguments).map((a) => expandMacros(a, ctx, prompt));
  const cwd = expandMacros(tool.workingDirectory.trim(), ctx, prompt) || ctx.projectRoot;
  return {
    id: `external:${tool.id}`,
    name: tool.name,
    kind: "external",
    command: program,
    args,
    cwd,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: null,
  };
}

/** The configuration running `tool` now (macros expanded, `$Prompt$` asked); null when cancelled or not possible. */
export async function externalToolConfig(tool: ExternalToolValid): Promise<RunConfig | null> {
  const ctx = currentContext();
  if (!ctx) return null;
  if (!tool.program.trim()) {
    notifications().notify({ level: "warning", title: `External tool '${tool.name}' has no program` });
    return null;
  }
  const uses = (m: string) => [tool.program, tool.arguments, tool.workingDirectory].some((t) => t.includes(m));
  let prompt = "";
  if (uses("$Prompt$")) {
    const value = await promptValue(tool.name);
    if (value === null) return null;
    prompt = value;
  }
  if (!ctx.filePath && ["$FilePath$", "$FileDir$", "$FileName$", "$FileRelativePath$"].some(uses)) {
    notifications().notify({ level: "warning", title: `'${tool.name}' needs an open file` });
    return null;
  }
  return toolRunConfig(tool, ctx, prompt);
}

export async function runExternalTool(tool: ExternalToolValid) {
  const config = await externalToolConfig(tool);
  if (!config) return;
  const session = await startRun(config, undefined, undefined, { show: tool.openConsole });
  if (!session || !tool.synchronizeAfter) return;
  // "Synchronize files after execution": reload the project from disk once the tool exits.
  let done = false;
  const check = () => {
    if (done) return;
    const cur = useRun.getState().sessions.find((x) => x.id === session.id);
    if (cur && cur.startedAt === session.startedAt && cur.status !== "finished" && cur.status !== "failed") return;
    done = true;
    unsub();
    if (cur?.startedAt === session.startedAt) void executeAction("project.refresh");
  };
  const unsub = useRun.subscribe(check);
  check();
}

function toolActions(tools: readonly ExternalToolValid[]): Action[] {
  return tools
    .filter((t) => t.enabled)
    .map((t) => ({
      id: `externalTools.${t.id}`,
      title: t.name,
      category: t.group || "External Tools",
      icon: "run",
      when: "projectOpen",
      keywords: ["external tool", "tools", ...(t.description ? [t.description] : [])],
      run: () => void runExternalTool(t),
    }));
}

/** Keeps one action per enabled tool registered. */
export function registerExternalTools(): () => void {
  let dispose = registerActions(toolActions(workflowSettings().externalTools));
  const unsub = onWorkflowSettingsChange(
    (s) => s.externalTools,
    (tools) => {
      dispose();
      dispose = registerActions(toolActions(tools));
    },
  );
  return () => {
    unsub();
    dispose();
  };
}
