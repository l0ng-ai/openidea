/**
 * The SQL of a MyBatis mapper XML file, as one text the SQL tools read: everything but the
 * SQL of `<select>` / `<insert>` / `<update>` / `<delete>` / `<sql>` is blanked out with
 * spaces (line breaks kept), so offsets are the file's own. Parameters (`#{id}`, `${col}`)
 * read as `?`, entities as their character, dynamic tags as nothing — except `<where>`,
 * `<set>`, `<trim prefix>` and `<foreach open / close>`, which read as what they add — and
 * each statement ends with a `;`.
 */

const STATEMENTS = new Set(["select", "insert", "update", "delete", "sql"]);
/** Their content is not part of the statement's SQL. */
const SKIPPED = new Set(["selectKey"]);
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export interface MapperSql {
  /** The file's text with only SQL left (same length). */
  text: string;
  /** The SQL text taken from the file, as ranges of offsets: the positions the SQL tools apply to. */
  segments: Array<{ from: number; to: number }>;
}

/** Whether `text` is a MyBatis (or iBatis) mapper. */
export function isMapper(text: string): boolean {
  const head = text.slice(0, 4000);
  return /<mapper[\s>]/.test(head) && /mybatis|ibatis|<mapper[^>]*\snamespace\s*=/i.test(head);
}

const TAG = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[|\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[2] ?? m[3] ?? "") : null;
}

export function mapperSql(doc: string): MapperSql {
  const out = doc.replace(/[^\n]/g, " ").split("");
  const segments: MapperSql["segments"] = [];
  /** Writes `what` at `at`, as far as `room` characters allow. */
  const put = (at: number, what: string, room: number) => {
    if (what.length > room) return;
    for (let i = 0; i < what.length; i++) out[at + i] = what[i]!;
  };
  const copy = (from: number, to: number) => {
    if (to <= from) return;
    let at = from;
    const text = doc.slice(from, to);
    // Parameters and entities inside the SQL text.
    const special = /#\{[^}]*\}?|\$\{[^}]*\}?|&(lt|gt|amp|quot|apos);/g;
    for (let m = special.exec(text); m; m = special.exec(text)) {
      const start = from + m.index;
      for (let i = at; i < start; i++) out[i] = doc[i]!;
      if (m[1]) put(start, ENTITIES[m[1]]!, m[0].length);
      else put(start, "?", m[0].length);
      at = start + m[0].length;
    }
    for (let i = at; i < to; i++) out[i] = doc[i]!;
    const last = segments.at(-1);
    if (last && last.to === from) last.to = to;
    else segments.push({ from, to });
  };

  /** Inside a statement: its depth of nested tags, the `close` text of open `<foreach>` / `<trim>`. */
  let statement: { name: string; depth: number } | null = null;
  const closes: Array<{ text: string | null; trailingComma: boolean }> = [];
  /** Where `<where>` / `<trim prefixOverrides>` drop a leading AND / OR, `<set>` a trailing comma. */
  const leading: number[] = [];
  const trailing: number[] = [];
  let skipping = 0;
  let textFrom = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(doc); m; m = TAG.exec(doc)) {
    const at = m.index;
    const end = at + m[0].length;
    if (statement && !skipping) copy(textFrom, at);
    textFrom = end;
    const [whole, closing, name, attrs = "", selfClosing] = m;
    // CDATA content is SQL text as written, markup characters included.
    if (whole === "<![CDATA[") {
      const close = doc.indexOf("]]>", end);
      const stop = close < 0 ? doc.length : close;
      if (statement && !skipping) copy(end, stop);
      textFrom = TAG.lastIndex = Math.min(doc.length, stop + 3);
      continue;
    }
    // Comments (and a stray `]]>`) are blank.
    if (!name) continue;
    if (!statement) {
      if (!closing && !selfClosing && STATEMENTS.has(name)) statement = { name, depth: 0 };
      continue;
    }
    if (closing) {
      if (statement.depth === 0 && name === statement.name) {
        put(at, ";", whole.length);
        statement = null;
        closes.length = 0;
        skipping = 0;
        continue;
      }
      statement.depth = Math.max(0, statement.depth - 1);
      if (skipping) {
        skipping--;
        continue;
      }
      const close = closes.pop();
      if (close?.trailingComma) trailing.push(at);
      if (close?.text) put(at, ` ${close.text} `, whole.length);
      continue;
    }
    if (selfClosing) continue;
    statement.depth++;
    if (skipping || SKIPPED.has(name)) {
      skipping++;
      continue;
    }
    let open: string | null = null;
    let close: string | null = null;
    let trailingComma = false;
    if (name === "where") {
      open = "where";
      leading.push(end);
    } else if (name === "set") {
      open = "set";
      trailingComma = true;
    } else if (name === "trim") {
      open = attr(attrs, "prefix");
      close = attr(attrs, "suffix");
      if (/\b(and|or)\b/i.test(attr(attrs, "prefixOverrides") ?? "")) leading.push(end);
      trailingComma = (attr(attrs, "suffixOverrides") ?? "").includes(",");
    } else if (name === "foreach") {
      open = attr(attrs, "open");
      close = attr(attrs, "close");
    }
    if (open) put(at, ` ${open} `, whole.length);
    closes.push({ text: close, trailingComma });
  }
  if (statement && !skipping) copy(textFrom, doc.length);
  for (const from of leading) {
    let i = from;
    while (i < out.length && /\s/.test(out[i]!)) i++;
    const word = /^(and|or)\b/i.exec(out.slice(i, i + 4).join(""));
    if (word) for (let k = 0; k < word[0].length; k++) out[i + k] = " ";
  }
  for (const before of trailing) {
    let i = before - 1;
    while (i >= 0 && /\s/.test(out[i]!)) i--;
    if (out[i] === ",") out[i] = " ";
  }
  return { text: out.join(""), segments };
}

/** Whether offset `pos` is in (or right after) SQL text of the mapper. */
export function inMapperSql(sql: MapperSql, pos: number): boolean {
  return sql.segments.some((s) => pos >= s.from && pos <= s.to);
}
