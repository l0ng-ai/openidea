/**
 * `.csv` / `.tsv` files as a table (DataGrip's CSV editor): the delimiter and the header row
 * guessed from the text, then the rows parsed with the result grid's own CSV reader.
 */
import { parseDelimited } from "./model";

export const isCsvPath = (path: string) => /\.(csv|tsv)$/i.test(path);

const DELIMITERS = [",", ";", "\t", "|"];
/** Enough lines to judge by, cut where a quoted field may run on. */
const SAMPLE = 64 * 1024;
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i;

/** Tab for `.tsv`; for `.csv` the candidate that splits the first lines into the most equal, widest rows. */
export function detectDelimiter(text: string, path: string): string {
  if (/\.tsv$/i.test(path)) return "\t";
  const cut = text.length > SAMPLE ? text.slice(0, text.lastIndexOf("\n", SAMPLE) + 1 || SAMPLE) : text;
  let best = { delimiter: ",", score: 0 };
  for (const delimiter of DELIMITERS) {
    const rows = parseDelimited(cut, delimiter).filter((r) => r.length > 1 || r[0] !== "");
    if (!rows.length) continue;
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    const [width, same] = [...counts].reduce((a, b) => (b[1] > a[1] || (b[1] === a[1] && b[0] > a[0]) ? b : a));
    if (width < 2) continue;
    // Share of rows with the common width first, then the width itself.
    const score = (same / rows.length) * 1000 + width;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

/** The first row names the columns when none of its cells is empty or a number and more rows follow. */
export function looksLikeHeader(rows: readonly string[][]): boolean {
  const first = rows[0];
  return !!first && rows.length > 1 && first.every((c) => c.trim() !== "" && !NUMBER.test(c.trim()));
}

export interface CsvTable {
  delimiter: string;
  header: boolean;
  columns: string[];
  rows: string[][];
}

/**
 * The file's table: blank lines skipped, short rows padded so every row has every column.
 * `header` overrides the guess; columns without a header name are numbered, and repeated
 * names get a suffix so sorting and filtering can tell them apart.
 */
export function parseCsv(text: string, path: string, header?: boolean): CsvTable {
  const delimiter = detectDelimiter(text, path);
  const rows = parseDelimited(text, delimiter).filter((r) => r.length > 1 || r[0] !== "");
  const named = header ?? looksLikeHeader(rows);
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const names = named ? rows.shift()! : [];
  const seen = new Set<string>();
  const columns = Array.from({ length: width }, (_, i) => {
    const base = names[i]?.trim() || `C${i + 1}`;
    let name = base;
    for (let n = 2; seen.has(name); n++) name = `${base}_${n}`;
    seen.add(name);
    return name;
  });
  for (const r of rows) while (r.length < width) r.push("");
  return { delimiter, header: named, columns, rows };
}
