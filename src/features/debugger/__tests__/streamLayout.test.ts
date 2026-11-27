import { describe, expect, it } from "vitest";
import { buildColumns, buildEdges, relatedTo } from "../streams/layout";
import { CHAIN_A_LINKS, CHAIN_A_RECORDS, CHAIN_A_STEPS } from "./streamChainA";

const label = (i: number) => {
  const r = CHAIN_A_RECORDS[i]!;
  const v = r.value;
  return `${r.step}=${v.kind === "string" ? JSON.stringify(v.text) : v.kind === "boxed" ? v.text : "?"}`;
};

describe("stream trace layout", () => {
  it("puts chain A's records into one column per step", () => {
    const columns = buildColumns(CHAIN_A_STEPS, CHAIN_A_RECORDS);
    expect(columns.map((c) => c.items.length)).toEqual([8, 4, 4, 4, 4]);
    expect(columns.map((c) => c.title)).toEqual(CHAIN_A_STEPS);
    expect(columns.map((c) => c.step)).toEqual([0, 1, 2, 3, 4]);
    expect(columns[3]!.items.map((it) => label(it.index))).toEqual(["3=21", "3=41", "3=61", "3=81"]);
  });

  it("titles the column of a stream held in a local Source", () => {
    const columns = buildColumns(["", "map"], [{ step: 0, value: { kind: "null" } }]);
    expect(columns.map((c) => c.title)).toEqual(["Source", "map"]);
    expect(columns[1]!.items).toEqual([]);
  });

  it("relates 0=8 to everything it became, across sorted", () => {
    const edges = buildEdges(CHAIN_A_LINKS);
    const start = CHAIN_A_RECORDS.findIndex((_, i) => label(i) === "0=8");
    const related = [...relatedTo(start, edges)].map(label).sort();
    expect(related).toEqual(["0=8", "1=8", "2=81", "3=81", '4="81"'].sort());
  });

  it("relates a later record back to its source only", () => {
    const edges = buildEdges(CHAIN_A_LINKS);
    const end = CHAIN_A_RECORDS.findIndex((_, i) => label(i) === '4="21"');
    expect([...relatedTo(end, edges)].map(label).sort()).toEqual(["0=2", "1=2", "2=21", "3=21", '4="21"'].sort());
  });

  it("keeps the siblings of a record out of what it relates to", () => {
    // flatMap: record 0 made 1 and 2; 1 is not related to 2.
    const edges = buildEdges([
      { parent: null, ambiguous: false },
      { parent: 0, ambiguous: false },
      { parent: 0, ambiguous: true },
    ]);
    expect([...relatedTo(1, edges)].sort()).toEqual([0, 1]);
  });

  it("drops links without a parent", () => {
    expect(
      buildEdges([
        { parent: null, ambiguous: false },
        { parent: 0, ambiguous: true },
        { parent: null, ambiguous: false },
        { parent: 2, ambiguous: false },
      ]),
    ).toEqual([
      { from: 0, to: 1, ambiguous: true },
      { from: 2, to: 3, ambiguous: false },
    ]);
  });
});
