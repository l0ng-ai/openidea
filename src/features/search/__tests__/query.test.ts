import { describe, expect, it } from "vitest";
import { parseLocationQuery, selectionOf } from "../common/query";

describe("parseLocationQuery", () => {
  it("passes plain text through", () => {
    expect(parseLocationQuery("OrderController")).toEqual({ text: "OrderController", line: null, col: null });
  });

  it("parses :line and :line:col (1-based in, 0-based out)", () => {
    expect(parseLocationQuery("File.kt:42")).toEqual({ text: "File.kt", line: 41, col: null });
    expect(parseLocationQuery("File.kt:42:5")).toEqual({ text: "File.kt", line: 41, col: 4 });
    expect(parseLocationQuery("src/a.ts:10:")).toEqual({ text: "src/a.ts", line: 9, col: null });
  });

  it("parses stack-trace style (line) suffixes", () => {
    expect(parseLocationQuery("Main.java(12)")).toEqual({ text: "Main.java", line: 11, col: null });
    expect(parseLocationQuery("lib.rs(3,7)")).toEqual({ text: "lib.rs", line: 2, col: 6 });
  });

  it("ignores :0 and non-numeric suffixes", () => {
    expect(parseLocationQuery("File.kt:0").line).toBeNull();
    expect(parseLocationQuery("a:b").text).toBe("a:b");
  });

  it("strips the project root from pasted absolute paths", () => {
    expect(parseLocationQuery("/dev/acme/src/Order.kt:3", "/dev/acme")).toEqual({
      text: "src/Order.kt",
      line: 2,
      col: null,
    });
    expect(parseLocationQuery("/elsewhere/x.kt", "/dev/acme").text).toBe("/elsewhere/x.kt");
  });

  it("handles quotes, file:// URLs and Windows separators", () => {
    expect(parseLocationQuery('"src/a.ts"').text).toBe("src/a.ts");
    expect(parseLocationQuery("file:///dev/acme/My%20File.kt", "/dev/acme").text).toBe("My File.kt");
    expect(parseLocationQuery("src\\main\\App.kt").text).toBe("src/main/App.kt");
    // Windows file URLs, with a space and an encoded `#` in the name (#4079).
    expect(parseLocationQuery("file:///C:/work/sample/src/a%20b%23c.txt", "C:/work/sample").text).toBe("src/a b#c.txt");
  });

  it("selectionOf maps to an editor selection", () => {
    expect(selectionOf({ line: null, col: null })).toBeUndefined();
    expect(selectionOf({ line: 4, col: null })).toEqual({ line: 4, col: 0 });
    expect(selectionOf({ line: 4, col: 2 })).toEqual({ line: 4, col: 2 });
  });
});
