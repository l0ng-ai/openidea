import { describe, expect, it } from "vitest";
import { pathContext, pathLike } from "./fileReferences";

describe("path completion context", () => {
  it("completes URL attributes, url(), @import and Markdown links eagerly", () => {
    expect(pathContext('<link rel="stylesheet" href="css/', "html")).toEqual({ prefix: "css/", eager: true });
    expect(pathContext("<img src=", "html")).toEqual({ prefix: "", eager: true });
    expect(pathContext(".a { background: url(../img/lo", "css")).toEqual({ prefix: "../img/lo", eager: true });
    expect(pathContext('@import "the', "scss")).toEqual({ prefix: "the", eager: true });
    expect(pathContext("See [docs](guide/", "markdown")).toEqual({ prefix: "guide/", eager: true });
  });

  it("completes string literals only once they look like paths", () => {
    expect(pathContext('open("data/x', "python")).toEqual({ prefix: "data/x", eager: false });
    expect(pathLike("data/x") && pathLike("./") && pathLike("../a")).toBe(true);
    expect(pathLike("hello")).toBe(false);
    // Closed strings and module specifiers (the language server's job) are left alone.
    expect(pathContext('log("done") + x', "python")).toBeNull();
    expect(pathContext('import { a } from "./ut', "typescript")).toBeNull();
    expect(pathContext('const m = await import("./m', "javascript")).toBeNull();
    expect(pathContext('fetch("./data/', "typescript")).toEqual({ prefix: "./data/", eager: false });
  });
});
