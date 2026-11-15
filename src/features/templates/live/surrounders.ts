/**
 * Language surrounders for Surround With (⌥⌘T): the fixed `if` / `while` /
 * `try` … wrappers IDEA lists above the `$SELECTION$` live templates. Bodies
 * use the live template syntax. Statement surrounders wrap whole lines;
 * expression surrounders wrap a selection within a line.
 */
import { TS_LANGS } from "./builtins";
import type { LiveTemplate, TemplateVariable } from "./model";

export interface Surrounder {
  id: string;
  description: string;
  body: string;
  variables?: TemplateVariable[];
  kind: "statement" | "expression";
}

type Def = Omit<Surrounder, "id" | "kind"> & { kind?: Surrounder["kind"] };

const v = (name: string, defaultValue?: string): TemplateVariable => ({ name, defaultValue });

function set(key: string, defs: Def[]): Surrounder[] {
  return defs.map((d, i) => ({ ...d, kind: d.kind ?? "statement", id: `${key}.${i}` }));
}

const braceBlock = (head: string) => `${head} {\n\t$SELECTION$\n}$END$`;
const region = (comment: string): Def => ({
  description: `${comment}region...${comment}endregion Comments`,
  body: `${comment}region $DESC$\n$SELECTION$\n${comment}endregion$END$`,
  variables: [v("DESC", '"Description"')],
});
const spacedRegion = (comment: string): Def => ({
  description: `${comment} region...${comment} endregion Comments`,
  body: `${comment} region $DESC$\n$SELECTION$\n${comment} endregion$END$`,
  variables: [v("DESC", '"Description"')],
});
const parens: Def = { description: "(expr)", body: "($SELECTION$)$END$", kind: "expression" };
const notParens: Def = { description: "!(expr)", body: "!($SELECTION$)$END$", kind: "expression" };

const java = set("java", [
  { description: "if", body: braceBlock("if ($COND$)") },
  { description: "if / else", body: "if ($COND$) {\n\t$SELECTION$\n} else {\n\t$END$\n}" },
  { description: "while", body: braceBlock("while ($COND$)") },
  { description: "do / while", body: "do {\n\t$SELECTION$\n} while ($COND$);$END$" },
  { description: "for", body: braceBlock("for ($INIT$; $COND$; $UPDATE$)") },
  {
    description: "try / catch",
    body: "try {\n\t$SELECTION$\n} catch ($EXC$ e) {\n\t$END$\n}",
    variables: [v("EXC", '"Exception"')],
  },
  { description: "try / finally", body: "try {\n\t$SELECTION$\n} finally {\n\t$END$\n}" },
  {
    description: "try / catch / finally",
    body: "try {\n\t$SELECTION$\n} catch ($EXC$ e) {\n\t$END$\n} finally {\n}",
    variables: [v("EXC", '"Exception"')],
  },
  { description: "synchronized", body: braceBlock("synchronized ($LOCK$)"), variables: [v("LOCK", '"this"')] },
  {
    description: "Runnable",
    body: "Runnable $NAME$ = new Runnable() {\n\tpublic void run() {\n\t\t$SELECTION$\n\t}\n};$END$",
    variables: [v("NAME", '"runnable"')],
  },
  { description: "{ }", body: "{\n\t$SELECTION$\n}$END$" },
  region("//"),
  parens,
  { description: "((Type)expr)", body: "(($TYPE$) $SELECTION$)$END$", kind: "expression" },
  notParens,
]);

const kotlin = set("kotlin", [
  { description: "if", body: braceBlock("if ($COND$)") },
  { description: "if / else", body: "if ($COND$) {\n\t$SELECTION$\n} else {\n\t$END$\n}" },
  { description: "while", body: braceBlock("while ($COND$)") },
  { description: "do / while", body: "do {\n\t$SELECTION$\n} while ($COND$)$END$" },
  { description: "for", body: braceBlock("for ($ITEM$ in $ITER$)") },
  {
    description: "try / catch",
    body: "try {\n\t$SELECTION$\n} catch (e: $EXC$) {\n\t$END$\n}",
    variables: [v("EXC", '"Exception"')],
  },
  { description: "try / finally", body: "try {\n\t$SELECTION$\n} finally {\n\t$END$\n}" },
  {
    description: "try / catch / finally",
    body: "try {\n\t$SELECTION$\n} catch (e: $EXC$) {\n\t$END$\n} finally {\n}",
    variables: [v("EXC", '"Exception"')],
  },
  { description: "{ } (function literal)", body: "{\n\t$SELECTION$\n}$END$" },
  { description: "run { }", body: braceBlock("run") },
  region("//"),
  parens,
  notParens,
]);

const js = set("js", [
  { description: "if", body: braceBlock("if ($COND$)") },
  { description: "if / else", body: "if ($COND$) {\n\t$SELECTION$\n} else {\n\t$END$\n}" },
  { description: "while", body: braceBlock("while ($COND$)") },
  { description: "do / while", body: "do {\n\t$SELECTION$\n} while ($COND$);$END$" },
  { description: "for", body: braceBlock("for (let $I$ = 0; $I$ < $N$; $I$++)"), variables: [v("I", '"i"')] },
  { description: "for...in", body: braceBlock("for (const $KEY$ in $OBJ$)"), variables: [v("KEY", '"key"')] },
  { description: "for...of", body: braceBlock("for (const $ITEM$ of $ITER$)"), variables: [v("ITEM", '"item"')] },
  { description: "try / catch", body: "try {\n\t$SELECTION$\n} catch (e) {\n\t$END$\n}" },
  { description: "try / finally", body: "try {\n\t$SELECTION$\n} finally {\n\t$END$\n}" },
  { description: "try / catch / finally", body: "try {\n\t$SELECTION$\n} catch (e) {\n\t$END$\n} finally {\n}" },
  { description: "{ }", body: "{\n\t$SELECTION$\n}$END$" },
  { description: "function", body: braceBlock("function $NAME$()") },
  region("//"),
  parens,
  notParens,
]);

const python = set("python", [
  { description: "if", body: "if $COND$:\n\t$SELECTION$\n$END$" },
  { description: "if / else", body: "if $COND$:\n\t$SELECTION$\nelse:\n\t$END$" },
  { description: "while", body: "while $COND$:\n\t$SELECTION$\n$END$" },
  { description: "for", body: "for $ITEM$ in $ITER$:\n\t$SELECTION$\n$END$" },
  {
    description: "try / except",
    body: "try:\n\t$SELECTION$\nexcept $EXC$:\n\t$END$",
    variables: [v("EXC", '"Exception"')],
  },
  { description: "try / finally", body: "try:\n\t$SELECTION$\nfinally:\n\t$END$" },
  {
    description: "try / except / finally",
    body: "try:\n\t$SELECTION$\nexcept $EXC$:\n\t$END$\nfinally:\n\tpass",
    variables: [v("EXC", '"Exception"')],
  },
  { description: "with", body: "with $EXPR$:\n\t$SELECTION$\n$END$" },
  { description: "def", body: "def $NAME$():\n\t$SELECTION$\n$END$" },
  spacedRegion("#"),
  parens,
  { description: "not (expr)", body: "not ($SELECTION$)$END$", kind: "expression" },
]);

const go = set("go", [
  { description: "if", body: braceBlock("if $COND$") },
  { description: "if / else", body: "if $COND$ {\n\t$SELECTION$\n} else {\n\t$END$\n}" },
  { description: "for", body: braceBlock("for $COND$") },
  { description: "func", body: "func() {\n\t$SELECTION$\n}()$END$" },
  { description: "{ }", body: "{\n\t$SELECTION$\n}$END$" },
  spacedRegion("//"),
  parens,
  notParens,
]);

const zig = set("zig", [
  { description: "if", body: braceBlock("if ($COND$)") },
  { description: "if / else", body: "if ($COND$) {\n\t$SELECTION$\n} else {\n\t$END$\n}" },
  { description: "while", body: braceBlock("while ($COND$)") },
  { description: "for", body: braceBlock("for ($ITER$) |$ITEM$|"), variables: [v("ITEM", '"item"')] },
  { description: "defer", body: braceBlock("defer") },
  { description: "test", body: braceBlock('test "$NAME$"'), variables: [v("NAME", '"name"')] },
  { description: "{ }", body: "{\n\t$SELECTION$\n}$END$" },
  region("//"),
  parens,
  notParens,
]);

const rust = set("rust", [
  { description: "if", body: braceBlock("if $COND$") },
  { description: "if / else", body: "if $COND$ {\n\t$SELECTION$\n} else {\n\t$END$\n}" },
  { description: "if let", body: braceBlock("if let $PAT$ = $EXPR$") },
  { description: "while", body: braceBlock("while $COND$") },
  { description: "loop", body: braceBlock("loop") },
  { description: "for", body: braceBlock("for $ITEM$ in $ITER$") },
  { description: "{ }", body: "{\n\t$SELECTION$\n}$END$" },
  { description: "unsafe { }", body: braceBlock("unsafe") },
  spacedRegion("//"),
  parens,
  notParens,
]);

/** The C-family languages without a dedicated set. */
const cLike = set("c", [
  { description: "if", body: braceBlock("if ($COND$)") },
  { description: "if / else", body: "if ($COND$) {\n\t$SELECTION$\n} else {\n\t$END$\n}" },
  { description: "while", body: braceBlock("while ($COND$)") },
  { description: "do / while", body: "do {\n\t$SELECTION$\n} while ($COND$);$END$" },
  { description: "{ }", body: "{\n\t$SELECTION$\n}$END$" },
  parens,
  notParens,
]);

const BY_LANGUAGE: Record<string, readonly Surrounder[]> = {
  java,
  kotlin,
  python,
  go,
  zig,
  rust,
  ...Object.fromEntries(TS_LANGS.map((l) => [l, js])),
  ...Object.fromEntries(["c", "cpp", "csharp", "swift", "scala", "dart", "php", "objective-c"].map((l) => [l, cLike])),
};

export interface SurroundSelection {
  /** The text covers whole lines (or is the statement / line at a caret). */
  lines: boolean;
  /** The text is a non-empty part of a single line. */
  inline: boolean;
}

export function surroundersFor(language: string, sel: SurroundSelection): Surrounder[] {
  const all = BY_LANGUAGE[language] ?? [];
  const statements = sel.lines || !sel.inline ? all.filter((s) => s.kind === "statement") : [];
  const expressions = sel.inline ? all.filter((s) => s.kind === "expression") : [];
  return [...statements, ...expressions];
}

/** One entry of the Surround With popup. */
export interface SurroundEntry {
  kind: "surrounder" | "template";
  id: string;
  mnemonic: string | null;
  /** For templates: the abbreviation character the mnemonic underlines. */
  mnemonicIndex: number | null;
}

/**
 * IDEA's mnemonics: surrounders get 1–9, 0, then A–Z in order; each template
 * the first character of its abbreviation not taken yet (none if all are).
 */
export function surroundEntries(
  surrounders: readonly Surrounder[],
  templates: readonly LiveTemplate[],
): SurroundEntry[] {
  const used = new Set<string>();
  const out: SurroundEntry[] = surrounders.map((s, i) => {
    const mnemonic = i < 9 ? String(i + 1) : i === 9 ? "0" : String.fromCharCode(65 + i - 10);
    used.add(mnemonic.toUpperCase());
    return { kind: "surrounder", id: s.id, mnemonic, mnemonicIndex: null };
  });
  for (const t of templates) {
    let index: number | null = null;
    for (let i = 0; i < t.abbrev.length; i++) {
      const c = t.abbrev[i]!.toUpperCase();
      if (!used.has(c)) {
        used.add(c);
        index = i;
        break;
      }
    }
    out.push({ kind: "template", id: t.id, mnemonic: index === null ? null : t.abbrev[index]!, mnemonicIndex: index });
  }
  return out;
}
