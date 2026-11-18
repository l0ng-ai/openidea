import { describe, expect, it } from "vitest";
import {
  ancestorsWithin,
  isInside,
  isSameOrInside,
  joinPath,
  nameOf,
  parentOf,
  relativeTo,
  splitExtension,
  tildify,
  uniqueName,
  validateName,
} from "./paths";

describe("path helpers", () => {
  it("joins, splits and relates paths", () => {
    expect(joinPath("/a", "b")).toBe("/a/b");
    expect(joinPath("/", "b")).toBe("/b");
    expect(parentOf("/a/b/c.txt")).toBe("/a/b");
    expect(parentOf("/a")).toBe("/");
    expect(nameOf("/a/b/c.txt")).toBe("c.txt");
    expect(isInside("/a/b", "/a")).toBe(true);
    expect(isInside("/ab", "/a")).toBe(false);
    expect(isInside("/a", "/a")).toBe(false);
    expect(isSameOrInside("/a", "/a")).toBe(true);
    expect(relativeTo("/r", "/r/src/x.ts")).toBe("src/x.ts");
    expect(relativeTo("/r", "/r")).toBe("");
    expect(relativeTo("/r", "/other")).toBe("/other");
  });

  it("lists ancestors within the root", () => {
    expect(ancestorsWithin("/r", "/r/a/b/c.txt")).toEqual(["/r", "/r/a", "/r/a/b"]);
    expect(ancestorsWithin("/r", "/r/x")).toEqual(["/r"]);
    expect(ancestorsWithin("/r", "/elsewhere/x")).toEqual([]);
  });

  it("abbreviates the home directory", () => {
    expect(tildify("/Users/me/dev/acme", "/Users/me")).toBe("~/dev/acme");
    expect(tildify("/Users/me", "/Users/me/")).toBe("~");
    expect(tildify("/Users/meow/x", "/Users/me")).toBe("/Users/meow/x");
    expect(tildify("/x", null)).toBe("/x");
  });

  it("splits extensions (dotfiles have none)", () => {
    expect(splitExtension("Foo.kt")).toEqual(["Foo", ".kt"]);
    expect(splitExtension("archive.tar.gz")).toEqual(["archive.tar", ".gz"]);
    expect(splitExtension(".gitignore")).toEqual([".gitignore", ""]);
    expect(splitExtension("Makefile")).toEqual(["Makefile", ""]);
  });

  it("generates Finder-style unique names", () => {
    const taken = new Set(["Foo.kt", "Foo copy.kt", "src"]);
    expect(uniqueName("Bar.kt", (n) => taken.has(n))).toBe("Bar.kt");
    expect(uniqueName("Foo.kt", (n) => taken.has(n))).toBe("Foo copy 2.kt");
    expect(uniqueName("src", (n) => taken.has(n), true)).toBe("src copy");
  });
});

describe("validateName", () => {
  const siblings = ["Order.kt", "model"];

  it("rejects empty, invalid and conflicting names", () => {
    expect(validateName("", { siblings }).error).toMatch(/empty/);
    expect(validateName("   ", { siblings }).error).toMatch(/empty/);
    expect(validateName("a\0b", { siblings }).error).toMatch(/invalid/);
    expect(validateName("..", { siblings }).error).toMatch(/not a valid/);
    expect(validateName("a/b", { siblings }).error).toMatch(/cannot contain/);
    expect(validateName("Order.kt", { siblings }).error).toMatch(/already exists/);
    expect(validateName("order.kt", { siblings, caseInsensitive: true }).error).toMatch(/already exists/);
    expect(validateName("order.kt", { siblings }).error).toBeNull();
    expect(validateName("a:b", { siblings, windows: true }).error).toMatch(/not a valid/);
  });

  it("allows nested paths for new items and validates each segment", () => {
    expect(validateName("pkg/Sub.kt", { siblings, allowNested: true }).error).toBeNull();
    expect(validateName("model/Sub.kt", { siblings, allowNested: true }).error).toBeNull();
    expect(validateName("pkg//Sub.kt", { siblings, allowNested: true }).error).toMatch(/empty path segment/);
    expect(validateName("/abs", { siblings, allowNested: true }).error).toMatch(/start with/);
  });

  it("rejects Windows names that the filesystem would trim", () => {
    const options = { siblings, allowNested: true };
    for (const name of ["example.txt.", "example.txt ", "folder./file", "folder /file"]) {
      expect(validateName(name, { ...options, windows: true }).error).toMatch(/end with a period or space/);
      expect(validateName(name, options).error).toBeNull();
    }
    expect(validateName(".settings/file.txt", { ...options, windows: true }).error).toBeNull();
  });

  it("accepts the current name and case-only renames", () => {
    expect(validateName("Order.kt", { siblings, current: "Order.kt" }).error).toBeNull();
    expect(validateName("order.kt", { siblings, current: "Order.kt", caseInsensitive: true }).error).toBeNull();
    expect(validateName("model", { siblings, current: "Order.kt" }).error).toMatch(/already exists/);
  });

  it("warns about surrounding spaces", () => {
    expect(validateName(" x ", { siblings }).warning).toBeTruthy();
  });
});
