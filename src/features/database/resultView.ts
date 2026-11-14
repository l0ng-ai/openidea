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

/** An exact decimal value: sign × digits × 10^exponent, digits without trailing zeroes. */
interface Decimal {
  negative: boolean;
  digits: bigint;
  exponent: number;
}

/** Beyond this exponent gap two values cannot be added with displayable digits; such selections keep the approximate total. */
const DECIMAL_DIGITS = 1_000_000;

/** The number of significant digits an inexact quotient keeps (as the previous display showed). */
const SIGNIFICANT = 12;

function parseDecimal(text: string): Decimal {
  const parts = NUMBER.exec(text)!;
  const fraction = parts[3] ?? "";
  const digits = BigInt(parts[2]! + fraction);
  const exponent = Number(parts[4] ?? "0") - fraction.length;
  if (!digits) return { negative: false, digits: 0n, exponent: 0 };
  return { negative: parts[1] === "-", ...withoutZeroes(digits, exponent) };
}

/** The value with trailing zeroes folded into the exponent (`250×10^-2` → `25×10^-1`); zero stays zero. */
function withoutZeroes(digits: bigint, exponent: number): { digits: bigint; exponent: number } {
  const text = digits.toString();
  const zeroes = text.length - text.replace(/0+$/, "").length;
  return zeroes && digits
    ? { digits: BigInt(text.slice(0, text.length - zeroes)), exponent: exponent + zeroes }
    : { digits, exponent };
}

/** The exact value as decimal text; extreme exponents stay compact in scientific notation. */
function decimalText(d: Decimal): string {
  if (!d.digits) return "0";
  const digits = d.digits.toString();
  const signed = (body: string) => (d.negative ? `-${body}` : body);
  const scientific = () =>
    signed(`${digits[0]!}${digits.length > 1 ? `.${digits.slice(1)}` : ""}e${d.exponent + digits.length - 1}`);
  if (d.exponent >= 0) return d.exponent <= 64 ? signed(digits + "0".repeat(d.exponent)) : scientific();
  const point = digits.length + d.exponent;
  if (point > 0) return signed(`${digits.slice(0, point)}.${digits.slice(point)}`);
  if (point >= -8) return signed(`0.${"0".repeat(-point)}${digits}`);
  return scientific();
}

/** a + b exactly; null when their exponents are too far apart for the digits to stay displayable. */
function addDecimal(a: Decimal, b: Decimal): Decimal | null {
  if (!a.digits) return b.digits ? b : { negative: false, digits: 0n, exponent: 0 };
  if (!b.digits) return a;
  const low = Math.min(a.exponent, b.exponent);
  if (Math.max(a.exponent, b.exponent) - low > DECIMAL_DIGITS) return null;
  const aligned = (d: Decimal) => (d.negative ? -1n : 1n) * d.digits * 10n ** BigInt(d.exponent - low);
  const sum = aligned(a) + aligned(b);
  if (!sum) return { negative: false, digits: 0n, exponent: 0 };
  return { negative: sum < 0n, ...withoutZeroes(sum < 0n ? -sum : sum, low) };
}

/** The exact sum of numeric texts; null when some values' exponents are too far apart. */
function sumDecimal(texts: readonly string[]): Decimal | null {
  let total: Decimal = { negative: false, digits: 0n, exponent: 0 };
  for (const text of texts) {
    const next = addDecimal(total, parseDecimal(text));
    if (next === null) return null;
    total = next;
  }
  return total;
}

/** a / divisor (divisor > 0): exact when the division terminates, else the fraction rounds half-up at `SIGNIFICANT` digits. */
function divideDecimal(a: Decimal, divisor: bigint): Decimal {
  if (!a.digits) return { negative: false, digits: 0n, exponent: 0 };
  let rest = a.digits % divisor;
  let text = (a.digits / divisor).toString();
  let fraction = "";
  while (rest && fraction.length < SIGNIFICANT) {
    rest *= 10n;
    fraction += (rest / divisor).toString();
    rest %= divisor;
  }
  const exponent = a.exponent - fraction.length;
  // Round half-up on the first dropped digit when the division does not terminate.
  if (rest && (rest * 10n) / divisor >= 5n) text = (BigInt(text + fraction) + 1n).toString();
  else text += fraction;
  return { negative: a.negative, ...withoutZeroes(BigInt(text), exponent) };
}

export interface Aggregates {
  count: number;
  distinct: number;
  nulls: number;
  /** When every non-NULL value is a number: the exact decimal text; null otherwise. */
  sum: Cell;
  avg: Cell;
  min: Cell;
  max: Cell;
  median: Cell;
}

/** The approximate total, average and median, for selections too far apart to combine exactly. */
function approximateAggregates(numbers: number[]): { sum: Cell; avg: Cell; median: Cell } {
  const total = numbers.reduce((a, b) => a + b, 0);
  const ordered = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return {
    sum: formatNumber(total),
    avg: formatNumber(total / numbers.length),
    median: formatNumber(ordered.length % 2 ? ordered[mid]! : (ordered[mid - 1]! + ordered[mid]!) / 2),
  };
}

/** IDEA's Aggregates view of the selected cells. */
export function aggregates(cells: readonly Cell[]): Aggregates {
  const present = cells.filter((c): c is string => c !== null);
  const numericTexts = present.filter((c) => NUMBER.test(c));
  const numeric = numericTexts.length > 0 && numericTexts.length === present.length;
  const sorted = [...present].sort(compareCells);
  let sum: Cell = null;
  let avg: Cell = null;
  let median: Cell = null;
  if (numeric) {
    const total = sumDecimal(numericTexts);
    if (total === null) ({ sum, avg, median } = approximateAggregates(numericTexts.map(Number)));
    else {
      sum = decimalText(total);
      avg = decimalText(divideDecimal(total, BigInt(numericTexts.length)));
      const ordered = [...numericTexts].sort(compareCells);
      const mid = Math.floor(ordered.length / 2);
      if (ordered.length % 2) median = ordered[mid]!;
      else {
        // The mean of the two middle values; halving a decimal sum is always exact.
        const middle = addDecimal(parseDecimal(ordered[mid - 1]!), parseDecimal(ordered[mid]!));
        median = middle === null ? null : decimalText(divideDecimal(middle, 2n));
      }
    }
  }
  return {
    count: cells.length,
    distinct: new Set(cells).size,
    nulls: cells.length - present.length,
    sum,
    avg,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    median,
  };
}

/** A number for display: integers as is, others to at most 6 significant decimals. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(12)));
}

export type ChartAggregate = "sum" | "avg" | "count" | "min" | "max" | "none";

export interface ChartPoint {
  label: string;
  /** The approximate value at which the mark is plotted. */
  value: number;
  /** The combined value exactly, as decimal text (the cell for `none`). */
  text: string;
}

/**
 * The chart's series: `y` per distinct `x` (in first-seen order), combined with
 * `agg`; `none` plots every row as is. Non-numeric `y` values are skipped
 * (except for `count`). Values combine exactly (a BIGINT sum must not round);
 * only the plot coordinates approximate them.
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
      .map((r) => ({ label: r[x] ?? "<null>", value: Number(r[y]), text: r[y]! }));
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const label = r[x] ?? "<null>";
    const v = r[y] ?? null;
    if (!groups.has(label)) groups.set(label, []);
    if (agg === "count") groups.get(label)!.push("1");
    else if (v !== null && NUMBER.test(v)) groups.get(label)!.push(v);
  }
  const combine = (v: string[]): string => {
    if (!v.length) return "0";
    switch (agg) {
      case "count":
        return String(v.length);
      case "min":
        return v.reduce((a, b) => (compareCells(a, b) <= 0 ? a : b));
      case "max":
        return v.reduce((a, b) => (compareCells(a, b) > 0 ? a : b));
      case "sum":
      case "avg": {
        const total = sumDecimal(v);
        // Exponents too far apart to combine exactly keep the approximate total.
        if (total === null) {
          const approximate = v.reduce((a, b) => a + Number(b), 0);
          return formatNumber(agg === "avg" ? approximate / v.length : approximate);
        }
        return agg === "avg" ? decimalText(divideDecimal(total, BigInt(v.length))) : decimalText(total);
      }
    }
  };
  return [...groups].map(([label, v]) => {
    const text = combine(v);
    return { label, value: Number(text), text };
  });
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
