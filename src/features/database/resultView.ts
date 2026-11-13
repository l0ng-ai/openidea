/**
 * Pure helpers of the result views: IDEA's local filter and client-side sort
 * of loaded rows, search in the grid, paging of console results, the
 * Aggregates of a selection, and the series of the chart.
 */
import type { Cell } from "./model";

/** Column index → the values still shown (IDEA's local filter: checked values). */
export type LocalFilter = ReadonlyMap<number, ReadonlySet<Cell>>;

export interface LocalSort {
  column: number;
  descending: boolean;
}

const NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;

// Beyond this many unscaled digits an exact sum would cost more than it is worth.
const MAX_SCALE_DIGITS = 4096n;

function decimalKey(value: string) {
  const parts = NUMBER.exec(value)!;
  const fraction = parts[3] ?? "";
  const digits = (parts[2]! + fraction).replace(/^0+/, "");
  if (!digits) return null;
  let end = digits.length;
  while (digits[end - 1] === "0") end--;
  return {
    negative: parts[1] === "-",
    digits: digits.slice(0, end),
    order: BigInt(parts[4] ?? "0") + BigInt(digits.length) - BigInt(fraction.length),
  };
}

function compareNumbers(a: string, b: string): number {
  const difference = Number(a) - Number(b);
  // Distinct floating-point values keep decimal order; rounded ties need the original digits.
  if (difference) return difference;
  const left = decimalKey(a);
  const right = decimalKey(b);
  if (!left) return !right ? 0 : right.negative ? 1 : -1;
  if (!right) return left.negative ? -1 : 1;
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const direction = left.negative ? -1 : 1;
  // Compare decimal orders without expanding even enormous exponents into zeroes.
  if (left.order !== right.order) return direction * (left.order < right.order ? -1 : 1);
  if (left.digits === right.digits) return 0;
  return direction * (left.digits < right.digits ? -1 : 1);
}

/** Numbers by value, then text; NULL first (as most databases sort ascending). */
export function compareCells(a: Cell, b: Cell): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (NUMBER.test(a) && NUMBER.test(b)) return compareNumbers(a, b);
  return a < b ? -1 : 1;
}

/**
 * The loaded rows to show, in order: those passing every column filter,
 * sorted by `sort` (stable, original order otherwise). Rows past `fixed`
 * (the table editor's added rows) always stay, last.
 */
export function visibleRows(
  rowCount: number,
  value: (row: number, col: number) => Cell,
  filter: LocalFilter,
  sort: LocalSort | null,
  fixed = rowCount,
): number[] {
  const rows: number[] = [];
  for (let r = 0; r < Math.min(rowCount, fixed); r++) {
    let shown = true;
    for (const [col, allowed] of filter) {
      if (!allowed.has(value(r, col))) {
        shown = false;
        break;
      }
    }
    if (shown) rows.push(r);
  }
  if (sort) {
    const dir = sort.descending ? -1 : 1;
    rows.sort((a, b) => dir * compareCells(value(a, sort.column), value(b, sort.column)) || a - b);
  }
  for (let r = fixed; r < rowCount; r++) rows.push(r);
  return rows;
}

/** Distinct values of a column with their counts, sorted (the filter popup's list). */
export function distinctValues(
  rowCount: number,
  value: (row: number, col: number) => Cell,
  col: number,
  limit = 1000,
): Array<{ value: Cell; count: number }> {
  const counts = new Map<Cell, number>();
  for (let r = 0; r < rowCount; r++) {
    const v = value(r, col);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts]
    .map(([v, count]) => ({ value: v, count }))
    .sort((a, b) => compareCells(a.value, b.value))
    .slice(0, limit);
}

/** The new filter after toggling `v` of column `col` (all checked again: no filter). */
export function toggleFilterValue(
  filter: LocalFilter,
  col: number,
  all: readonly Cell[],
  v: Cell,
  checked: boolean,
): LocalFilter {
  const next = new Map(filter);
  const current = new Set(filter.get(col) ?? all);
  if (checked) current.add(v);
  else current.delete(v);
  if (all.every((x) => current.has(x))) next.delete(col);
  else next.set(col, current);
  return next;
}

export interface Aggregates {
  count: number;
  distinct: number;
  nulls: number;
  /** When every non-NULL value is a number: the exact total as decimal text; null otherwise. */
  sum: string | null;
  avg: string | null;
  min: Cell;
  max: Cell;
  median: string | null;
}

/** IDEA's Aggregates view of the selected cells. */
export function aggregates(cells: readonly Cell[]): Aggregates {
  const present = cells.filter((c): c is string => c !== null);
  const numeric = present.length > 0 && present.every((c) => NUMBER.test(c));
  const sorted = [...present].sort(compareCells);
  let median: string | null = null;
  let sum: string | null = null;
  if (numeric) {
    sum = exactSum(present);
    const mid = Math.floor(sorted.length / 2);
    median = sorted.length % 2 ? exactText(sorted[mid]!) : exactAverage(exactSum(sorted.slice(mid - 1, mid + 1)), 2);
  }
  return {
    count: cells.length,
    distinct: new Set(cells).size,
    nulls: cells.length - present.length,
    sum,
    avg: sum === null ? null : exactAverage(sum, present.length),
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    median,
  };
}

/** A decimal's digits and power of ten: `digits × 10^scale`, sign included in `digits`. */
interface Decimal {
  digits: bigint;
  scale: bigint;
}

/** The exact decimal of a numeric cell; `null` when it is not a number. */
function decimalOf(value: string): Decimal | null {
  const parts = NUMBER.exec(value);
  if (!parts) return null;
  const fraction = parts[3] ?? "";
  let digits = (parts[2]! + fraction).replace(/^0+/, "");
  let scale = BigInt(parts[4] ?? "0") - BigInt(fraction.length);
  if (!digits) return { digits: 0n, scale: 0n };
  // Normalize: the trailing zeroes of the digits belong to the scale.
  let end = digits.length;
  while (digits[end - 1] === "0") end--;
  scale += BigInt(digits.length - end);
  digits = digits.slice(0, end);
  return { digits: (parts[1] === "-" ? -1n : 1n) * BigInt(digits), scale };
}

/** `digits × 10^scale` as a plain decimal string, or `null` when that would be enormous. */
function decimalText(digits: bigint, scale: bigint): string | null {
  if (digits === 0n) return "0";
  let normalized = digits;
  let exponent = scale;
  // Trailing zeroes belong to the exponent: 650×10⁻¹⁸ is 6.5.
  while (normalized % 10n === 0n) {
    normalized /= 10n;
    exponent += 1n;
  }
  const negative = normalized < 0n;
  const text = (negative ? -normalized : normalized).toString();
  let body: string;
  if (exponent >= 0n) {
    if (BigInt(text.length) + exponent > MAX_SCALE_DIGITS) return null;
    body = text + "0".repeat(Number(exponent));
  } else {
    const point = BigInt(text.length) + exponent;
    if (point > 0n) {
      body = `${text.slice(0, Number(point))}.${text.slice(Number(point))}`;
    } else {
      if (-point > MAX_SCALE_DIGITS) return null;
      body = `0.${"0".repeat(Number(-point))}${text}`;
    }
  }
  return negative ? `-${body}` : body;
}

/** The exact sum of numeric cells; `null` when one is not a number or too large to expand. */
function exactSum(values: readonly string[]): string | null {
  const decimals = values.map(decimalOf);
  if (decimals.some((d) => d === null)) return null;
  const scale = decimals.reduce((low, d) => (d!.scale < low ? d!.scale : low), decimals[0]!.scale);
  let total = 0n;
  for (const d of decimals) {
    const shift = d!.scale - scale;
    if (shift > MAX_SCALE_DIGITS) return null;
    total += d!.digits * 10n ** shift;
  }
  return decimalText(total, scale);
}

/**
 * `sum / count`: the exact decimal when the division terminates (every median of an
 * even count does), else 17 significant digits, the precision a double carries.
 */
function exactAverage(sum: string | null, count: number): string | null {
  if (sum === null || count === 0) return null;
  const decimal = decimalOf(sum);
  if (!decimal) return null;
  const abs = (n: bigint) => (n < 0n ? -n : n);
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  const den = BigInt(count);
  let reduced = den / gcd(abs(decimal.digits), den);
  // A reduced denominator made only of 2s and 5s gives a terminating decimal.
  let twos = 0;
  while (reduced % 2n === 0n) {
    reduced /= 2n;
    twos++;
  }
  let fives = 0;
  while (reduced % 5n === 0n) {
    reduced /= 5n;
    fives++;
  }
  if (reduced === 1n) {
    const places = Math.max(twos, fives);
    return decimalText((decimal.digits * 10n ** BigInt(places)) / den, decimal.scale - BigInt(places));
  }
  // Repeating: scale so the quotient keeps 17 significant digits, rounding half up.
  const size = (n: bigint) => abs(n).toString().length;
  const pow = BigInt(Math.max(0, 17 + size(den) - size(decimal.digits)));
  const numerator = decimal.digits * 10n ** pow;
  let quotient = numerator / den;
  const remainder = numerator % den;
  if (remainder !== 0n && 2n * abs(remainder) >= den) quotient += numerator < 0n ? -1n : 1n;
  return decimalText(quotient, decimal.scale - pow);
}

/** The exact text of a numeric cell, for a point label that keeps every digit. */
function exactText(value: string): string | null {
  const decimal = decimalOf(value);
  return decimal ? decimalText(decimal.digits, decimal.scale) : null;
}

/** A number for display: integers as is, others to at most 6 significant decimals. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(12)));
}

export type ChartAggregate = "sum" | "avg" | "count" | "min" | "max" | "none";

export interface ChartPoint {
  label: string;
  /** The plot coordinate: an approximation of `exact` once it can't be a double. */
  value: number;
  /** The exact combined value, for the label and tooltip; `null` for `count` groups. */
  exact: string | null;
}

/**
 * The chart's series: `y` per distinct `x` (in first-seen order), combined with
 * `agg`; `none` plots every row as is. Non-numeric `y` values are skipped
 * (except for `count`).
 */
export function chartSeries(
  rows: ReadonlyArray<readonly Cell[]>,
  x: number,
  y: number,
  agg: ChartAggregate,
): ChartPoint[] {
  if (agg === "none")
    return rows
      .filter((r) => r[y] !== null && NUMBER.test(r[y]!))
      .map((r) => {
        const exact = exactText(r[y]!);
        return { label: r[x] ?? "<null>", value: Number(r[y]), exact };
      });
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const label = r[x] ?? "<null>";
    const v = r[y] ?? null;
    if (!groups.has(label)) groups.set(label, []);
    if (agg === "count") groups.get(label)!.push("1");
    else if (v !== null && NUMBER.test(v)) groups.get(label)!.push(v);
  }
  const combine = (v: string[]): { value: number; exact: string | null } => {
    if (!v.length) return { value: 0, exact: null };
    // Too large to expand exactly: the plot still needs a coordinate.
    const approximate = (f: (n: number[]) => number) => f(v.map(Number));
    switch (agg) {
      case "sum": {
        const exact = exactSum(v);
        return { value: exact === null ? approximate((n) => n.reduce((a, b) => a + b, 0)) : Number(exact), exact };
      }
      case "avg": {
        const exact = exactAverage(exactSum(v), v.length);
        const value = exact === null ? approximate((n) => n.reduce((a, b) => a + b, 0) / n.length) : Number(exact);
        return { value, exact };
      }
      case "min":
      case "max":
      case "count": {
        const sorted = agg === "count" ? v : [...v].sort(compareCells);
        const picked = agg === "max" ? sorted.at(-1)! : sorted[0]!;
        if (agg === "count") return { value: v.length, exact: null };
        return { value: Number(picked), exact: exactText(picked) };
      }
    }
  };
  return [...groups].map(([label, v]) => ({ label, ...combine(v) }));
}

/** Round axis ticks from 0 (or the minimum, when negative) to `max`. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.floor(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Number(t.toPrecision(12)));
  if (out.at(-1)! < hi) out.push(Number((out.at(-1)! + step).toPrecision(12)));
  return out;
}

/** IDEA's search options of the grid's search bar. */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const WORD_CHAR = /[\p{L}\p{N}_$]/u;

/** A test of a cell's text against `query`; `null` without a query, `"invalid"` for a bad regex. */
export function cellMatcher(query: string, options: SearchOptions): ((text: string) => boolean) | null | "invalid" {
  if (!query) return null;
  const source = options.regex ? query : query.replace(REGEX_SPECIALS, "\\$&");
  let re: RegExp;
  try {
    re = new RegExp(source, options.caseSensitive ? "gu" : "giu");
  } catch {
    return "invalid";
  }
  // Words: a match with no word character on either side (no lookbehind: older WebKit lacks it).
  return (text) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (end === start) {
        // Step a whole code point: with the `u` flag a lastIndex inside a surrogate pair
        // snaps back to the pair's start, which would match the same empty string forever.
        re.lastIndex = start + ((text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1);
        if (!options.wholeWord) return true;
        continue;
      }
      if (!options.wholeWord || (!WORD_CHAR.test(text[start - 1] ?? "") && !WORD_CHAR.test(text[end] ?? "")))
        return true;
    }
    return false;
  };
}

/** The cells matching `test`, row by row; `row` is the position in `rows` (display order). NULL never matches. */
export function findCells(
  rows: readonly number[],
  colCount: number,
  value: (row: number, col: number) => Cell,
  test: (text: string) => boolean,
): Array<{ row: number; col: number }> {
  const out: Array<{ row: number; col: number }> = [];
  rows.forEach((r, row) => {
    for (let col = 0; col < colCount; col++) {
      const v = value(r, col);
      if (v !== null && test(v)) out.push({ row, col });
    }
  });
  return out;
}

/** Whether any cell of loaded row `r` matches `test`. */
export function rowMatches(
  r: number,
  colCount: number,
  value: (row: number, col: number) => Cell,
  test: (text: string) => boolean,
): boolean {
  for (let col = 0; col < colCount; col++) {
    const v = value(r, col);
    if (v !== null && test(v)) return true;
  }
  return false;
}

export interface PageState {
  /** Zero-based page shown. */
  page: number;
  pageSize: number;
  /** Rows on the page. */
  rows: number;
  /** More rows follow the page. */
  hasMore: boolean;
  /** Counted rows of the whole query, when known. */
  total: number | null;
}

export interface PageWindow {
  /** One-based numbers of the first and last row shown (0 and 0 on an empty page). */
  first: number;
  last: number;
  /** Rows of the whole query: known once counted or on reaching the end. */
  total: number | null;
  /** Zero-based last page, when the total is known. */
  lastPage: number | null;
}

/** What the pager shows ("1-500 of 501+"). */
export function pageWindow({ page, pageSize, rows, hasMore, total }: PageState): PageWindow {
  const offset = page * pageSize;
  const known = total ?? (hasMore ? null : offset + rows);
  return {
    first: rows ? offset + 1 : 0,
    last: offset + rows,
    total: known,
    lastPage: known === null ? null : Math.max(0, Math.ceil(known / pageSize) - 1),
  };
}

/** A page is read by running the query again: the backend reads past the rows before it and returns only the page. */
export function pageFetch(page: number, pageSize: number): { maxRows: number; skip: number } {
  return { maxRows: pageSize, skip: page * pageSize };
}
