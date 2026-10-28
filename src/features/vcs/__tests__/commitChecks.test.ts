import { describe, expect, it } from "vitest";
import { badFileName } from "../commitChecks";

describe("badFileName", () => {
  const root = "/repo";

  it("flags names reserved on Windows, with or without an extension", () => {
    expect(badFileName(["/repo/src/con.ts"], root)).toEqual({ name: "con.ts", kind: "reserved" });
    expect(badFileName(["/repo/LPT1/a.txt"], root)).toEqual({ name: "LPT1", kind: "reserved" });
  });

  it("flags characters Windows rejects", () => {
    expect(badFileName(["/repo/docs/what?.md"], root)).toEqual({ name: "what?.md", kind: "char" });
    expect(badFileName(["/repo/a:b"], root)).toEqual({ name: "a:b", kind: "char" });
  });

  it("accepts ordinary names, including ones that merely contain a reserved word", () => {
    expect(badFileName(["/repo/src/console.ts", "/repo/com10.txt", "/repo/.auxrc"], root)).toBeNull();
  });
});
