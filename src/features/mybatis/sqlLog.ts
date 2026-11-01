/**
 * MyBatis console log → executable SQL (BatsLog-style): every `==>  Preparing:`
 * statement gets its `?` placeholders filled from the following
 * `==> Parameters: v1(T1), v2(T2)` line — numbers raw, strings quoted and
 * escaped, null → NULL. Several pairs in the selection become several
 * statements, joined with `;\n\n`, each ending in `;`. The SQL text itself is
 * kept exactly as MyBatis logged it (no formatting).
 *
 * shortcut: parameters must sit on one line (MyBatis prints them so), and a
 * value literally containing `), ` cannot be round-tripped.
 */

const NUMERIC_TYPES = new Set(["Long", "Integer", "Short", "Byte", "Double", "Float", "BigDecimal", "BigInteger"]);

interface ParsedParam {
  value: string;
  type: string | null;
}

/**
 * Splits `1(Long), admin(String), null` into parameter pairs. Values may
 * contain commas (`a, b(String)`) because only a `(Type)` ending (or a bare
 * `null`) closes a parameter: bare segments are re-joined with the next
 * typed one.
 */
function parseParams(s: string): ParsedParam[] {
  const out: ParsedParam[] = [];
  const bare: string[] = [];
  const flush = () => {
    if (bare.length) out.push({ value: bare.join(", "), type: null });
    bare.length = 0;
  };
  for (const segment of s.split(/,\s*/)) {
    if (!segment) continue;
    const typed = /^(.*)\(([^)]*)\)$/.exec(segment);
    if (typed) {
      out.push({ value: [...bare, typed[1]!].filter((x) => x !== "").join(", ") || "", type: typed[2]! });
      bare.length = 0;
    } else if (segment === "null") {
      flush();
      out.push({ value: "null", type: null });
    } else {
      bare.push(segment);
    }
  }
  flush();
  return out;
}

function formatValue(p: ParsedParam): string {
  if (p.value === "null") return "NULL";
  if (p.type && NUMERIC_TYPES.has(p.type)) return p.value;
  if (p.type === "Boolean") return p.value;
  // Typeless values (only null normally) fall back to a numeric / boolean guess.
  if (/^-?\d+(?:\.\d+)?$/.test(p.value) || /^(true|false)$/.test(p.value)) return p.value;
  return `'${p.value.replace(/'/g, "''")}'`;
}

function fillParams(sql: string, params: readonly ParsedParam[]): string {
  let i = 0;
  // Short params keep their `?`; extra params are ignored.
  return sql.replace(/\?/g, () => (i < params.length ? formatValue(params[i++]!) : "?"));
}

const PREPARING = /==>\s*Preparing:\s*(.*)$/;
const PARAMETERS = /==>\s*Parameters:\s*(.*)$/;

/** The executable SQL of the selection, or null without any `Preparing` line. */
export function sqlFromMybatisLog(text: string): string | null {
  const statements: string[] = [];
  let pending: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const prep = PREPARING.exec(line);
    if (prep) {
      // A previous statement without parameters keeps its placeholders.
      if (pending !== null) statements.push(pending);
      pending = prep[1] ?? "";
      continue;
    }
    const params = PARAMETERS.exec(line);
    if (params && pending !== null) {
      statements.push(fillParams(pending, parseParams(params[1] ?? "")));
      pending = null;
    }
  }
  if (pending !== null) statements.push(pending);
  if (!statements.length) return null;
  return statements.map((s) => `${s.replace(/\s*$/, "")};`).join("\n\n");
}
