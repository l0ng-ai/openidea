/**
 * Console highlight rules from plugins (API 1.12, `ui.set-console-rules`) for
 * Run and Debug output. The host validated each pattern: no construct that
 * reads differently here than in Rust's `regex`, and none that could backtrack
 * for long on a line of `MAX_RULE_TEXT` characters (`console_rules.rs`).
 * A whole-line match replaces the level colour (`logColors`); a rule's colours
 * and styles replace the program's own ANSI ones where they apply.
 */
import type { ConsoleRule } from "@/bindings";
import type { Span, SpanStyle } from "./ansi";

/** The characters of a line rules see; the host's complexity check assumes this many. */
const MAX_RULE_TEXT = 2000;
/** Styled matches kept per line. */
const MAX_RANGES = 200;
/** Lines whose result is remembered before the cache starts over. */
const MAX_CACHED = 2000;

const COLORS = new Set(["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]);

interface CompiledRule {
  re: RegExp;
  wholeLine: boolean;
  style: SpanStyle;
}

interface ConsoleRuleSet {
  rules: readonly CompiledRule[];
  cache: Map<string, ConsoleRuleMatch | null>;
}

interface RuleRange {
  /** UTF-16 offsets into the line's text. */
  start: number;
  end: number;
  style: SpanStyle;
}

export interface ConsoleRuleMatch {
  /** The style of the first whole-line rule that matched. */
  line?: SpanStyle;
  /** Matched text of match-only rules, in order, never overlapping. */
  ranges: readonly RuleRange[];
}

function color(name: string | null): string | undefined {
  if (!name) return undefined;
  return COLORS.has(name.replace(/^bright-/, "")) ? `var(--ansi-${name})` : undefined;
}

function styleOf(rule: ConsoleRule): SpanStyle {
  const has = (s: string) => rule.styles.includes(s) || undefined;
  const style: SpanStyle = {
    fg: color(rule.foreground),
    bg: color(rule.background),
    bold: has("bold"),
    italic: has("italic"),
    underline: has("underline"),
    strike: has("strikethrough"),
    dim: has("dim"),
  };
  return Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined)) as SpanStyle;
}

const compiled = new WeakMap<ReadonlyMap<string, readonly ConsoleRule[]>, ConsoleRuleSet>();

/** The enabled rules of every provider, in provider id order then list order. */
export function compileConsoleRules(providers: ReadonlyMap<string, readonly ConsoleRule[]>): ConsoleRuleSet {
  let set = compiled.get(providers);
  if (set) return set;
  const rules: CompiledRule[] = [];
  for (const id of [...providers.keys()].sort()) {
    for (const rule of providers.get(id)!) {
      if (!rule.enabled) continue;
      try {
        rules.push({
          re: new RegExp(rule.pattern, rule.ignoreCase ? "gi" : "g"),
          wholeLine: rule.wholeLine,
          style: styleOf(rule),
        });
      } catch {
        // Valid for the host but not here: the rule is skipped.
      }
    }
  }
  set = { rules, cache: new Map() };
  compiled.set(providers, set);
  return set;
}

/** Adds the parts of `[start, end)` no earlier range covers. */
function addUncovered(ranges: RuleRange[], start: number, end: number, style: SpanStyle) {
  let from = start;
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    if (r.end <= from || r.start >= end) continue;
    if (r.start > from) ranges.push({ start: from, end: r.start, style });
    from = Math.max(from, r.end);
    if (from >= end) return;
  }
  if (from < end) ranges.push({ start: from, end, style });
}

function evaluate(seen: string, set: ConsoleRuleSet): ConsoleRuleMatch | null {
  let line: SpanStyle | undefined;
  const ranges: RuleRange[] = [];
  for (const rule of set.rules) {
    rule.re.lastIndex = 0;
    if (rule.wholeLine) {
      if (!line && rule.re.test(seen)) line = rule.style;
      continue;
    }
    for (let m = rule.re.exec(seen); m && ranges.length < MAX_RANGES; m = rule.re.exec(seen)) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      addUncovered(ranges, m.index, m.index + m[0].length, rule.style);
    }
  }
  if (!line && ranges.length === 0) return null;
  ranges.sort((a, b) => a.start - b.start);
  return { line, ranges };
}

/**
 * What the rules make of one line, or `undefined` when none applies (also for a
 * stream the IDE owns). The same text gives the same object until the rules change.
 */
export function matchConsoleRules(text: string, kind: string, set: ConsoleRuleSet): ConsoleRuleMatch | undefined {
  if (set.rules.length === 0 || (kind !== "stdout" && kind !== "stderr")) return undefined;
  const seen = text.length > MAX_RULE_TEXT ? text.slice(0, MAX_RULE_TEXT) : text;
  let result = set.cache.get(seen);
  if (result === undefined) {
    if (set.cache.size >= MAX_CACHED) set.cache.clear();
    result = evaluate(seen, set);
    set.cache.set(seen, result);
  }
  return result ?? undefined;
}

/** `spans` with the rule styles laid over them: whole-line first, then the matched ranges. */
export function styleSpans(spans: readonly Span[], match: ConsoleRuleMatch): Span[] {
  const out: Span[] = [];
  let pos = 0;
  let ri = 0;
  const { ranges } = match;
  for (const span of spans) {
    const base = match.line ? { ...span, ...match.line } : span;
    let offset = 0;
    while (offset < span.text.length) {
      const abs = pos + offset;
      while (ri < ranges.length && ranges[ri]!.end <= abs) ri++;
      const range = ranges[ri];
      let take = span.text.length - offset;
      let style: SpanStyle | undefined;
      if (range && range.start <= abs) {
        style = range.style;
        take = Math.min(take, range.end - abs);
      } else if (range) {
        take = Math.min(take, range.start - abs);
      }
      const text = span.text.slice(offset, offset + take);
      out.push(style ? { ...base, ...style, text } : { ...base, text });
      offset += take;
    }
    pos += span.text.length;
  }
  return out;
}
