import { describe, expect, it } from "vitest";
import type { Cell } from "./model";
import { aggregates, chartSeries } from "./resultView";

const finiteMeans = [
  { count: 1, total: "1", expected: "1" },
  { count: 125, total: "1", expected: "0.008" },
  { count: 4096, total: "1", expected: "0.000244140625" },
  { count: 8192, total: "1", expected: "0.0001220703125" },
  { count: 8192, total: "-1", expected: "-0.0001220703125" },
  { count: 16384, total: "1", expected: "0.00006103515625" },
  { count: 32768, total: "1", expected: "0.000030517578125" },
  { count: 40960, total: "1", expected: "0.0000244140625" },
  { count: 24576, total: "3", expected: "0.0001220703125" },
  { count: 8192, total: "10000000000000000", expected: "1220703125000" },
  { count: 8192, total: "-1e16", expected: "-1220703125000" },
  { count: 8192, total: "1e400", expected: "1.220703125e396" },
  { count: 8192, total: "1e-400", expected: "1.220703125e-404" },
  { count: 8192, total: "0001.000e0", expected: "0.0001220703125" },
  { count: 8192, total: "1.0000000000000000001", expected: "0.00012207031250000000001220703125" },
  { count: 8192, total: "-0.00", expected: "0" },
];

function cellsWithTotal(count: number, total: string): string[] {
  return [total, ...Array<string>(count - 1).fill("0")];
}

const meanOf = {
  selection: (cells: readonly Cell[]) => aggregates(cells).avg,
  chart: (cells: readonly Cell[]) =>
    chartSeries(
      cells.map((cell) => ["same", cell]),
      0,
      1,
      "avg",
    )[0]?.text ?? null,
};

describe.each(Object.entries(meanOf))("%s means", (_, mean) => {
  it.each(finiteMeans)("keeps $total / $count exact", ({ count, total, expected }) => {
    expect(mean(cellsWithTotal(count, total))).toBe(expected);
  });

  it("excludes NULL from the divisor", () => {
    expect(mean([null, ...cellsWithTotal(8192, "1"), null])).toBe("0.0001220703125");
  });

  it("preserves cancellation before dividing", () => {
    const cells = cellsWithTotal(8192, "9007199254740993");
    cells[1] = "-9007199254740992";
    expect(mean(cells)).toBe("0.0001220703125");
  });

  it.each([
    { count: 3, total: "1", expected: "0.333333333333" },
    { count: 3, total: "-2", expected: "-0.666666666667" },
    { count: 17, total: "1", expected: "0.058823529412" },
    { count: 3, total: "3000000000001", expected: "1000000000000.333333333333" },
    { count: 24576, total: "1", expected: "0.000040690104" },
    { count: 73728, total: "3", expected: "0.000040690104" },
  ])("retains the existing repeating quotient $total / $count", ({ count, total, expected }) => {
    expect(mean(cellsWithTotal(count, total))).toBe(expected);
  });
});

function rational(text: string): { numerator: bigint; denominator: bigint } {
  const [mantissa, exponent = "0"] = text.toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const coefficient = BigInt(whole! + fraction);
  const scale = fraction.length - Number(exponent);
  return scale >= 0
    ? { numerator: coefficient, denominator: 10n ** BigInt(scale) }
    : { numerator: coefficient * 10n ** BigInt(-scale), denominator: 1n };
}

describe("finite means against independent rational arithmetic", () => {
  const counts = [1, 2, 5, 16, 25, 40, 125, 4096, 8192, 16384];
  it.each(Array.from({ length: 60 }, (_, i) => i))("preserves the exact fraction in sample %i", (sample) => {
    let seed = 0x6f31ad82 ^ sample;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const count = counts[sample % counts.length]!;
    const a = (2n ** 63n + BigInt(random())) * (sample % 2 ? -1n : 1n);
    const b = count > 1 ? (2n ** 60n + BigInt(random())) * (sample % 3 ? 1n : -1n) : 0n;
    const exponent = (random() % 801) - 400;
    const cells = cellsWithTotal(count, `${a}e${exponent}`);
    if (count > 1) cells[count - 1] = `${b}e${exponent}`;
    const numerator = (a + b) * 10n ** BigInt(Math.max(0, exponent));
    const denominator = BigInt(count) * 10n ** BigInt(Math.max(0, -exponent));
    for (const mean of Object.values(meanOf)) {
      const actual = rational(mean(cells)!);
      expect(actual.numerator * denominator).toBe(numerator * actual.denominator);
    }
  });
});

describe("mean calculation regressions", () => {
  it.each(([[], [null], [null, null], ["text"], ["1", "text"]] satisfies Cell[][]).map((cells) => ({ cells })))(
    "keeps a non-numeric selection disabled: $cells",
    ({ cells }) => {
      expect(aggregates(cells).avg).toBeNull();
    },
  );

  it("uses each chart group's numeric cells for its mean", () => {
    const rows: Cell[][] = [
      ...cellsWithTotal(8192, "1").map((value) => ["fraction", value]),
      ["fraction", null],
      ["fraction", "text"],
      ["ordinary", "0.1"],
      ["ordinary", "0.2"],
    ];
    expect(chartSeries(rows, 0, 1, "avg")).toEqual([
      { label: "fraction", text: "0.0001220703125", value: 0.0001220703125 },
      { label: "ordinary", text: "0.15", value: 0.15 },
    ]);
  });

  it("retains exact odd and even medians", () => {
    expect(aggregates(["9007199254740993", "9007199254740992"]).median).toBe("9007199254740992.5");
    expect(aggregates(["1e-400", "2e-400"]).median).toBe("1.5e-400");
    expect(aggregates(["1", "2", "3"]).median).toBe("2");
  });

  it("retains the existing fallback for an excessive exponent gap", () => {
    expect(aggregates(["1e2000000000", "1"]).avg).toBe("Infinity");
    expect(
      chartSeries(
        [
          ["same", "1e2000000000"],
          ["same", "1"],
        ],
        0,
        1,
        "avg",
      )[0]?.text,
    ).toBe("Infinity");
  });
});
