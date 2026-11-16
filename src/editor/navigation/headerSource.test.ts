import { describe, expect, it } from "vitest";
import { counterpartNames, headerSourceItems, rankCounterparts } from "./headerSource";

describe("header / source counterparts", () => {
  it("names the other side by stem", () => {
    expect(counterpartNames("/p/src/foo.cpp")?.names).toContain("foo.h");
    expect(counterpartNames("/p/src/foo.cpp")?.group).toBe("Header");
    expect(counterpartNames("/p/include/foo.hpp")?.names).toEqual(expect.arrayContaining(["foo.cc", "foo.mm"]));
    expect(counterpartNames("/p/include/foo.HPP")?.group).toBe("Source");
    expect(counterpartNames("/p/main.rs")).toBeNull();
    expect(counterpartNames("/p/Makefile")).toBeNull();
  });

  it("prefers the same folder, else the nearest", () => {
    expect(rankCounterparts("/p/src/a/foo.cpp", ["/p/include/foo.h", "/p/src/a/foo.h", "/p/src/a/foo.hpp"])).toEqual([
      "/p/src/a/foo.h",
      "/p/src/a/foo.hpp",
    ]);
    expect(rankCounterparts("/p/src/a/foo.cpp", ["/x/foo.h", "/p/include/foo.h", "/p/src/b/foo.h"])).toEqual([
      "/p/src/b/foo.h",
      "/p/include/foo.h",
      "/x/foo.h",
    ]);
  });

  it("collects the matches of every counterpart name", async () => {
    const files: Record<string, string[]> = { "foo.h": ["/p/foo.h"], "foo.hpp": ["/q/foo.hpp"] };
    const items = await headerSourceItems("/p/foo.c", async (n) => files[n] ?? []);
    expect(items).toEqual([{ path: "/p/foo.h", group: "Header" }]);
  });
});
