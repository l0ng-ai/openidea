/**
 * Run Highlighted Command (IDEA's smart command execution): shell integration marks the
 * prompt's end (OSC 133 B), so the command being typed is known. One a Run Anything provider
 * recognises (`pytest`, `npm run dev`, `gradle test`, a run configuration's name) is
 * highlighted, and ⌘↩ / Ctrl+Enter runs it with the IDE; plain Enter still runs it in the shell.
 *
 * Off in the alternate buffer and while a command runs. Grey text after the cursor is a shell
 * autosuggestion (zsh-autosuggestions, fish), and right-aligned text after it a right prompt:
 * neither is part of the command.
 */
import type { IBufferCell, IBufferLine, IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import { workflowSettings } from "@/platform/workflowSettings";
import { runAnythingProviderList } from "@/workbench/contributions";

export const SMART_COMMAND_CLASS = "openidea-terminal-smart-command";

/** Operators, redirections, variables and substitutions: such a line is the shell's to run. */
const SHELL_SYNTAX = /[|&;<>$`\n]/;

/** Where the typed command starts: the cell after the prompt. */
export interface PromptEnd {
  marker: IMarker;
  x: number;
}

export interface TypedCommand {
  text: string;
  /** Cells to highlight per buffer row, `[start, end)`. */
  rows: { y: number; start: number; end: number }[];
}

/** An autosuggestion's cell: dim, or the palette's bright black (zsh-autosuggestions' `fg=8`). */
const suggested = (cell: IBufferCell) => cell.isDim() !== 0 || (cell.isFgPalette() && cell.getFgColor() === 8);

/** The cell after the last non-blank one of `line`. */
function trimmedEnd(line: IBufferLine, cell: IBufferCell): number {
  for (let x = line.length - 1; x >= 0; x--) {
    const c = line.getCell(x, cell);
    if (c?.getChars().trim()) return x + Math.max(c.getWidth(), 1);
  }
  return 0;
}

const blank = (line: IBufferLine, x: number, cell: IBufferCell) => !line.getCell(x, cell)?.getChars().trim();

/**
 * Where a right prompt (zsh's `RPROMPT`) on the cursor's row begins: text after `from` (the
 * cursor) that reaches the right edge and is set off by two or more blanks. Returns the first
 * blank of that gap, or null when there is none.
 */
function rightPromptStart(line: IBufferLine, cell: IBufferCell, end: number, from: number): number | null {
  if (end < line.length - 1) return null;
  let x = end - 1;
  for (let blanks = 0; x >= from; x--) {
    if (!blank(line, x, cell)) blanks = 0;
    else if (++blanks === 2) break;
  }
  if (x < from) return null;
  while (x >= from && blank(line, x, cell)) x--;
  return x + 1;
}

/** The command typed after `prompt`, across wrapped rows; null when nothing is typed. */
export function typedCommand(term: Terminal, prompt: PromptEnd): TypedCommand | null {
  const buf = term.buffer.active;
  if (buf.type !== "normal" || prompt.marker.isDisposed || prompt.marker.line < 0) return null;
  const cursorY = buf.baseY + buf.cursorY;
  const cell = buf.getNullCell();
  const rows: TypedCommand["rows"] = [];
  let text = "";
  for (let y = prompt.marker.line; ; y++) {
    const line = buf.getLine(y);
    if (!line || (y > prompt.marker.line && !line.isWrapped)) break;
    const start = y === prompt.marker.line ? prompt.x : 0;
    // A row the next one continues is full: its trailing blanks are part of the command.
    let end = buf.getLine(y + 1)?.isWrapped ? line.length : trimmedEnd(line, cell);
    let cut = false;
    const right = y === cursorY ? rightPromptStart(line, cell, end, buf.cursorX) : null;
    if (right !== null) {
      end = right;
      cut = true;
    }
    if (y === cursorY && buf.cursorX < end) {
      let all = true;
      for (let x = buf.cursorX; x < end && all; x++) {
        const c = line.getCell(x, cell);
        if (c?.getChars().trim() && !suggested(c)) all = false;
      }
      if (all) {
        end = buf.cursorX;
        cut = true;
      }
    }
    if (end > start) {
      text += line.translateToString(false, start, end);
      rows.push({ y, start, end });
    }
    if (cut) break;
  }
  const command = text.trim();
  if (!command) return null;
  // Leading blanks are not highlighted.
  const lead = text.length - text.trimStart().length;
  if (rows[0] && lead) rows[0] = { ...rows[0], start: rows[0].start + lead };
  return { text: command, rows };
}

/** Whether a Run Anything provider runs `line` (typed in the absolute folder `cwd`) as a command it recognises. */
export function recognised(line: string, cwd: string): boolean {
  if (SHELL_SYNTAX.test(line)) return false;
  return runAnythingProviderList().some((p) => !!p.execute && !!p.accepts?.(line, cwd));
}

/** Runs `line` with the first provider that takes it; false when none did. */
export async function runRecognised(line: string, cwd: string): Promise<boolean> {
  if (SHELL_SYNTAX.test(line)) return false;
  for (const p of runAnythingProviderList())
    if (p.accepts?.(line, cwd) && p.execute && (await p.execute(line, cwd))) return true;
  return false;
}

export const smartCommandsEnabled = () => workflowSettings().terminal.runCommandsUsingIde;

export interface SmartCommandController extends IDisposable {
  /** Drops the highlight and checks again, e.g. after the prompt moved or a setting changed. */
  refresh(): void;
}

/**
 * Highlights the typed command while a provider recognises it. `prompt` is null while no
 * prompt waits for input (a command runs, or the shell sends no OSC 133 B).
 */
export function installSmartCommands(
  term: Terminal,
  prompt: () => PromptEnd | null,
  cwd: () => string,
): SmartCommandController {
  const shown: { marker: IMarker; decoration: IDecoration }[] = [];
  let key = "";
  let rafId = 0;
  let disposed = false;

  const clear = () => {
    for (const s of shown.splice(0)) {
      s.decoration.dispose();
      s.marker.dispose();
    }
  };

  const update = () => {
    rafId = 0;
    if (disposed) return;
    const at = smartCommandsEnabled() ? prompt() : null;
    const typed = at ? typedCommand(term, at) : null;
    const match = typed && recognised(typed.text, cwd()) ? typed : null;
    const next = match ? JSON.stringify(match.rows) : "";
    if (next === key && shown.every((s) => !s.marker.isDisposed)) return;
    key = next;
    clear();
    if (!match) return;
    const buf = term.buffer.active;
    for (const row of match.rows) {
      const marker = term.registerMarker(row.y - (buf.baseY + buf.cursorY));
      if (!marker) continue;
      const decoration = term.registerDecoration({
        marker,
        x: row.start,
        width: row.end - row.start,
      });
      if (!decoration) {
        marker.dispose();
        continue;
      }
      decoration.onRender((el) => el.classList.add(SMART_COMMAND_CLASS));
      shown.push({ marker, decoration });
    }
  };

  const schedule = () => {
    if (!rafId && !disposed) rafId = requestAnimationFrame(update);
  };
  const subs = [term.onRender(schedule), term.onCursorMove(schedule), term.buffer.onBufferChange(schedule)];

  return {
    refresh() {
      key = "";
      clear();
      schedule();
    },
    dispose() {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      subs.forEach((s) => s.dispose());
      clear();
    },
  };
}
