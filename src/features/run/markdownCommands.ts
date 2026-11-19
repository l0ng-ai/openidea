/**
 * Run icons in Markdown files, like IDEA's Markdown command runner: ▶ on a shell
 * code block's opening fence runs the block in a new terminal tab, and ▶ on a
 * line of any code block runs it when a Run Anything provider recognizes the
 * command (`mvn test`, `./gradlew build`, a run configuration's name).
 */
import type { Extension } from "@codemirror/state";
import type { EditorDocContext } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { markdownCommandSettings } from "@/platform/languageSettings";
import { useProject } from "@/platform/project";
import type { MenuItem } from "@/ui";
import { runAnythingProviderList } from "@/workbench/contributions";
import { entryGutter, type ScriptEntry } from "./npmGutter";

const SHELL = new Set(["sh", "bash", "zsh", "shell", "shellscript", "shell-script", "console"]);
const POWERSHELL = new Set(["powershell", "pwsh", "ps1"]);
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

export interface CommandEntry extends ScriptEntry {
  kind: "block" | "line";
  /** What runs: the block's commands, or the line's. */
  lines: string[];
}

/** `line` without a trailing `# comment` outside quotes. */
function stripComment(line: string): string {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !double) single = !single;
    else if (c === '"' && !single) double = !double;
    else if (c === "#" && !single && !double && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i).trimEnd();
  }
  return line;
}

/** Shell lines without a leading `$` prompt or trailing comments; empty lines dropped. */
export function trimPrompt(lines: readonly string[]): string[] {
  return lines.map((line) => stripComment(line.startsWith("$") ? line.slice(1) : line).trim()).filter(Boolean);
}

/**
 * The runnable places of Markdown `text`: shell code blocks (on their opening fence)
 * and code block lines `accepts` recognizes as commands.
 */
export function markdownCommands(text: string, accepts: (line: string) => boolean): CommandEntry[] {
  const lines = text.split("\n");
  const out: CommandEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!);
    if (!open) continue;
    const marker = open[1]!;
    const language = open[2]!.toLowerCase();
    const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end]!)) end++;
    const body = lines.slice(i + 1, end).map((l) => l.replace(/\r$/, ""));
    if (SHELL.has(language) || POWERSHELL.has(language)) {
      const commands = POWERSHELL.has(language) ? body.filter((l) => l.trim()) : trimPrompt(body);
      if (commands.length) out.push({ kind: "block", name: `block:${i}`, line: i, lines: commands });
    }
    body.forEach((raw, k) => {
      const [command] = trimPrompt([raw]);
      if (command && accepts(command))
        out.push({ kind: "line", name: `line:${command}`, line: i + 1 + k, lines: [command] });
    });
    i = end;
  }
  return out;
}

/** Whether a Run Anything provider runs `line` as a command it recognizes. */
function accepted(line: string): boolean {
  return runAnythingProviderList().some((p) => !!p.accepts?.(line));
}

async function runLine(line: string) {
  for (const p of runAnythingProviderList()) if (p.accepts?.(line) && p.execute && (await p.execute(line))) return;
}

const parentDir = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";

/** The folders a block may run in: the setting's, or both when it asks and they differ. */
function directories(path: string): { project: string; file: string } | string | null {
  const { project, settings } = useProject.getState();
  if (!project?.root) return null;
  const file = parentDir(path);
  const choice = markdownCommandSettings(settings).commandDirectory;
  if (choice === "file") return file;
  if (choice === "project" || file === project.root) return project.root;
  return { project: project.root, file };
}

function runBlock(lines: string[], cwd: string) {
  void executeAction("terminal.runLines", { lines, cwd });
}

export async function commandMenuItems(entry: ScriptEntry, path: string): Promise<MenuItem[]> {
  const command = entry as CommandEntry;
  if (command.kind === "line") {
    const line = command.lines[0]!;
    return [{ label: tx`Run '${line}'`, icon: "run", run: () => void runLine(line) }];
  }
  const dirs = directories(path);
  if (!dirs) return [];
  const shown = typeof dirs === "string" ? "" : dirs.file.slice(dirs.project.length + 1) || dirs.file;
  if (typeof dirs === "string")
    return [{ label: tx`Run in Terminal`, icon: "terminal", run: () => runBlock(command.lines, dirs) }];
  return [
    { label: tx`Run from Project Root Directory`, icon: "terminal", run: () => runBlock(command.lines, dirs.project) },
    {
      label: tx`Run from Parent Directory of Current File (${shown})`,
      icon: "terminal",
      run: () => runBlock(command.lines, dirs.file),
    },
  ];
}

export function markdownCommandGutter(ctx: EditorDocContext): Extension {
  const { project, settings } = useProject.getState();
  if (!project?.trusted || !markdownCommandSettings(settings).runCommands) return [];
  return entryGutter(
    ctx,
    /\.(md|markdown)$/i,
    (text) => markdownCommands(text, accepted),
    commandMenuItems,
    (entry) => {
      const command = entry as CommandEntry;
      return command.kind === "block" ? tx`Run in Terminal` : tx`Run '${command.lines[0]!}'`;
    },
  );
}
