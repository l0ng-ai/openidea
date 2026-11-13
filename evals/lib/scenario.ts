/** What an eval scenario is: a project, a step the user takes, and what they should see. */
import type { ResultSet } from "./golden.ts";
import type { Tracked } from "./measure.ts";
import type { Session } from "./session.ts";
import type { Condition } from "./verdict.ts";

export interface Measured {
  timing: Tracked;
  results?: ResultSet;
  /** Why the answer is weaker than a semantic one, when the UI says so. */
  degraded?: string | null;
}

export interface EvalScenario {
  /** Stable id: `<language>.<group>.<case>`, used by `--only`, goldens and budgets. */
  id: string;
  title: string;
  /** `fixtures/<fixture>`. */
  fixture: string;
  /** The language server whose readiness the warm runs wait for. */
  server: string;
  conditions: Condition[];
  /** Brings the idle workbench to where the step starts (open a file, place the caret). */
  setup(s: Session): Promise<void>;
  /** The measured step. */
  step(s: Session): Promise<Measured>;
}

/** Project-relative path, or a library class's URI without its machine-specific query. */
export function normalizePath(root: string, path: string): string {
  if (path.startsWith(root + "/")) return path.slice(root.length + 1);
  const uri = /^[a-z]+:\/\//.exec(path);
  if (uri) return path.replace(/[?#].*$/, "");
  return path;
}
