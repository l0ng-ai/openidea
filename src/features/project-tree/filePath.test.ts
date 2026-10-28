import { describe, expect, it } from "vitest";
import { filePathChain } from "./filePath";

describe("filePathChain", () => {
  it("lists the file then every folder up to the root", () => {
    expect(filePathChain("/work/app/src/main.ts")).toEqual([
      "/work/app/src/main.ts",
      "/work/app/src",
      "/work/app",
      "/work",
      "/",
    ]);
  });

  it("stops at a Windows drive root", () => {
    expect(filePathChain("C:/Users/me/a.txt")).toEqual(["C:/Users/me/a.txt", "C:/Users/me", "C:/Users", "C:/"]);
  });
});
