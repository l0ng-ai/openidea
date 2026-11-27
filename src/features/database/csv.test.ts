import { describe, expect, it } from "vitest";
import { detectDelimiter, looksLikeHeader, parseCsv } from "./csv";

const BOM = String.fromCharCode(0xfeff);

describe("csv", () => {
  it("detects the delimiter that splits rows evenly", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n", "x.csv")).toBe(",");
    expect(detectDelimiter('name;price\n"a,b";1,5\nc;2,0\n', "x.csv")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2\n", "x.csv")).toBe("\t");
    expect(detectDelimiter("a|b|c\n1|2|3\n", "x.csv")).toBe("|");
    // .tsv is always tab-separated, even when commas split more.
    expect(detectDelimiter("a,b,c\td\n", "x.tsv")).toBe("\t");
    expect(detectDelimiter("one column\nvalue\n", "x.csv")).toBe(",");
  });

  it("takes the first row as the header only when it looks like one", () => {
    expect(
      looksLikeHeader([
        ["id", "name"],
        ["1", "a"],
      ]),
    ).toBe(true);
    expect(
      looksLikeHeader([
        ["1", "a"],
        ["2", "b"],
      ]),
    ).toBe(false);
    expect(
      looksLikeHeader([
        ["id", ""],
        ["1", "a"],
      ]),
    ).toBe(false);
    expect(looksLikeHeader([["id", "name"]])).toBe(false);
  });

  it("parses quoted fields with line breaks, a BOM and ragged rows", () => {
    const t = parseCsv(BOM + 'id,note\n1,"two\nlines, ""quoted"""\n\n2\n', "x.csv");
    expect(t).toEqual({
      delimiter: ",",
      header: true,
      columns: ["id", "note"],
      rows: [
        ["1", 'two\nlines, "quoted"'],
        ["2", ""],
      ],
    });
  });

  it("names columns without a header and keeps repeated names apart", () => {
    expect(parseCsv("1,2\n3,4\n", "x.csv").columns).toEqual(["C1", "C2"]);
    expect(parseCsv("a,a,\n1,2,3\n", "x.csv", true).columns).toEqual(["a", "a_2", "C3"]);
    const forced = parseCsv("id,name\n1,a\n", "x.csv", false);
    expect([forced.header, forced.rows.length]).toEqual([false, 2]);
  });
});
