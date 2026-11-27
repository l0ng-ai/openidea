import { tx } from "@/platform/i18n";

/** How the program that reads a pasted path reads a word. `arg` is a program that splits its own input, with no shell in between. */
export type QuoteDialect = "powershell" | "cmd" | "fish" | "posix" | "arg";

/** Letters, digits and separators that no shell reads as anything but part of a path. */
const PLAIN_POSIX = /^(?!-)[\p{L}\p{N}_./:-]+$/u;
const PLAIN_WINDOWS = /^(?!-)[\p{L}\p{N}_./\\:-]+$/u;
/** PowerShell ends a single-quoted string at any of these, the typographic ones included. */
const POWERSHELL_QUOTES = /['\u2018\u2019\u201a\u201b]/gu;

export function dialectOf(shell: string | null | undefined, windows: boolean): QuoteDialect {
  if (shell == null) return windows ? "arg" : "posix";
  const name = shell.toLowerCase().replace(/\.exe$/, "");
  if (name === "cmd") return "cmd";
  if (name === "powershell" || name === "pwsh") return "powershell";
  if (name === "fish") return "fish";
  return "posix";
}

/**
 * `path` as one word that `dialect` reads as that file name and nothing else, so a name like
 * `a$(calc).txt` or `a;rm -rf x` cannot run a command from the prompt. Plain paths stay bare unless
 * `always`. Throws for a name no quoting can make safe.
 */
export function quoteForShell(path: string, dialect: QuoteDialect, always = false): string {
  if (/\p{Cc}/u.test(path)) throw new Error(tx("Cannot paste this path safely: its name contains control characters."));
  if (!always && (dialect === "posix" || dialect === "fish" ? PLAIN_POSIX : PLAIN_WINDOWS).test(path)) return path;
  switch (dialect) {
    case "powershell":
      return `'${path.replace(POWERSHELL_QUOTES, "$&$&")}'`;
    case "cmd":
      if (/["%!]/.test(path))
        throw new Error(tx("Cannot paste this path safely in cmd.exe. Use PowerShell or a POSIX shell."));
      return `"${path}"`;
    case "arg":
      return `"${path}"`;
    case "fish":
      return `'${path.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    case "posix":
      return `'${path.replaceAll("'", "'\\''")}'`;
  }
}
