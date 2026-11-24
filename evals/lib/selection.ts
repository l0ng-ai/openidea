import { countOption } from "../../perf/lib/options.ts";
import type { Condition } from "./verdict.ts";

interface Scenario {
  id: string;
  title: string;
  conditions: readonly Condition[];
}

export interface ExpectedOutcome {
  scenario: string;
  title: string;
  condition: Condition;
}

export function planSelection<T extends Scenario>(
  scenarios: readonly T[],
  args: { only?: string; condition?: string; runs?: string; warmup?: string },
) {
  const runs = countOption("runs", args.runs ?? "3", 1);
  const warmup = countOption("warmup", args.warmup ?? "1", 0);
  if (args.condition !== undefined && args.condition !== "warm" && args.condition !== "cold")
    throw new Error("--condition must be warm or cold");
  const condition = args.condition as Condition | undefined;
  const selectors = args.only?.split(",").map((s) => s.trim());
  const matches = (s: T, selector: string) => s.id === selector || s.id.startsWith(`${selector}.`);
  for (const selector of selectors ?? []) {
    if (!selector) throw new Error("--only contains an empty selector");
    const matching = scenarios.filter((s) => matches(s, selector));
    if (!matching.length) throw new Error(`no scenario matches ${selector} (see --list)`);
    if (!matching.some((s) => s.conditions.some((c) => !condition || c === condition)))
      throw new Error(`no compatible scenario for selector ${selector} under ${condition}`);
  }
  const selected = scenarios.filter((s) => !selectors || selectors.some((selector) => matches(s, selector)));
  const expected: ExpectedOutcome[] = selected.flatMap((s) =>
    s.conditions
      .filter((c) => !condition || c === condition)
      .map((c) => ({ scenario: s.id, title: s.title, condition: c })),
  );
  if (!expected.length) throw new Error("no compatible scenarios selected");
  return { selected, expected, runs, warmup, condition };
}
