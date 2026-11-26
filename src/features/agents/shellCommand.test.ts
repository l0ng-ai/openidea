import { describe, expect, it } from "vitest";
import { splitLeadingCd } from "./shellCommand";

describe("splitLeadingCd", () => {
  it("takes the folder off the front", () => {
    expect(splitLeadingCd("cd /repo && git status")).toEqual({ command: "git status", dir: "/repo" });
    expect(splitLeadingCd(`cd "/my repo/" ; ls`)).toEqual({ command: "ls", dir: "/my repo" });
    expect(splitLeadingCd("cd /tmp")).toEqual({ command: "cd /tmp", dir: null });
  });
});
