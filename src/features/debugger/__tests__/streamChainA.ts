/**
 * Chain A as JDK 11–25 record it: `nums.stream().filter(x -> x % 2 == 0).map(x -> x * 10 + 1)
 * .sorted().map(String::valueOf).toList()` over `[5, 3, 8, 1, 4, 2, 9, 6]`. The links are what
 * `link_trace` gives for it (`ready_links_the_collected_records` in ide-host checks the same log).
 */
import type { JvmValue, Link, StreamChainInfo, StreamTraceResult, TraceRecordView } from "@/platform/ipc";

const LOG: [number, string][] = [
  [0, "5"],
  [0, "3"],
  [0, "8"],
  [1, "8"],
  [2, "81"],
  [0, "1"],
  [0, "4"],
  [1, "4"],
  [2, "41"],
  [0, "2"],
  [1, "2"],
  [2, "21"],
  [0, "9"],
  [0, "6"],
  [1, "6"],
  [2, "61"],
  [3, "21"],
  [4, "21"],
  [3, "41"],
  [4, "41"],
  [3, "61"],
  [4, "61"],
  [3, "81"],
  [4, "81"],
];

/** `filter` and both `map`s link to the latest record of the step before; `sorted` by the boxed value. */
const PARENTS = [
  null,
  null,
  null,
  2,
  3,
  null,
  null,
  6,
  7,
  null,
  9,
  10,
  null,
  null,
  13,
  14,
  11,
  16,
  8,
  18,
  15,
  20,
  4,
  22,
];

const value = (step: number, text: string, i: number): JvmValue =>
  step === 4
    ? { kind: "string", id: 100 + i, text, length: text.length }
    : { kind: "boxed", id: 100 + i, typeName: "java.lang.Integer", text };

export const CHAIN_A_RECORDS: TraceRecordView[] = LOG.map(([step, text], i) => ({ step, value: value(step, text, i) }));

export const CHAIN_A_LINKS: Link[] = PARENTS.map((parent) => ({ parent, ambiguous: false }));

export const CHAIN_A_STEPS = ["stream", "filter", "map", "sorted", "map"];

export const CHAIN_A: StreamChainInfo = {
  index: 0,
  range: { start: { line: 5, col: 4 }, end: { line: 10, col: 20 } },
  text: "nums.stream()\n    .filter(x -> x % 2 == 0)\n    .map(x -> x * 10 + 1)\n    .sorted()\n    .map(String::valueOf)\n    .toList()",
  steps: ["filter", "map", "sorted", "map"],
  terminal: "toList",
  available: true,
};

export const CHAIN_A_READY: Extract<StreamTraceResult, { status: "ready" }> = {
  status: "ready",
  chain: CHAIN_A,
  steps: CHAIN_A_STEPS,
  records: CHAIN_A_RECORDS,
  links: CHAIN_A_LINKS,
  terminal: { kind: "value", value: { kind: "object", id: 7, typeName: "java.util.ImmutableCollections$ListN" } },
  banners: [],
  generation: 9,
};
