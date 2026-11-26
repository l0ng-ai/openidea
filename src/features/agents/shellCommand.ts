/** Reading what an agent's shell command does, from its text alone. */

/** A leading `cd <dir> &&` (or `;`), with the directory quoted or bare. */
const LEADING_CD = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/;

/** `command` without the `cd <dir> &&` agents put before it, and that folder; `null` when there is none. */
export function splitLeadingCd(command: string): { command: string; dir: string | null } {
  const match = LEADING_CD.exec(command);
  if (!match || match[0].length === command.length) return { command, dir: null };
  const dir = match[1]!.replace(/^(["'])(.*)\1$/, "$2").replace(/\/+$/, "");
  return { command: command.slice(match[0].length), dir };
}
