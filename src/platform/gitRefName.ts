/** Ports IntelliJ's `GitRefNameValidator.cleanUpBranchNameOnTyping` (git4idea). */

/** IntelliJ's advanced setting `git.branch.cleanup.symbol` (default `-`). */
export const BRANCH_CLEANUP_SYMBOL = "-";

// Characters and sequences git forbids that cannot be repaired by substitution are dropped.
const DROP = /^\.|^-|^\/|[~:^?*"[\\]+|(?:@\{)+|\/(?=\/)|(?:\.(?=\.))+|\.(?=\/)|(?<=\/)\./g;
// A run of whitespace / control characters becomes one separator. It also absorbs separators
// mixed into or next to it, so pressing Space again after the substituted one doesn't stack them (IntelliJ
// collapses only spaces typed in one go).
const SEPARATOR = BRANCH_CLEANUP_SYMBOL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REPLACE = new RegExp(`(?:${SEPARATOR}|[ \\p{Cc}])*[ \\p{Cc}](?:${SEPARATOR}|[ \\p{Cc}])*`, "gu");

function cleanOnce(name: string): string {
  return name.replace(DROP, "").replace(REPLACE, BRANCH_CLEANUP_SYMBOL);
}

/**
 * Makes `name` typable as a branch name: forbidden characters are dropped and spaces become the
 * cleanup symbol, so a space never reaches the validator. Runs to a fixed point because the
 * substitution can itself form a forbidden start (" x" → "-x" → "x").
 */
export function cleanUpBranchNameOnTyping(name: string): string {
  let cleaned = name;
  for (;;) {
    const next = cleanOnce(cleaned);
    if (next === cleaned) return cleaned;
    cleaned = next;
  }
}
