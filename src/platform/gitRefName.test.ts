import { describe, expect, it } from "vitest";
import { cleanUpBranchNameOnTyping } from "./gitRefName";

describe("cleanUpBranchNameOnTyping", () => {
  it.each([
    // The reported case: a space typed or pasted between words.
    ["feature x", "feature-x"],
    ["fix login redirect", "fix-login-redirect"],
    // Repeated spaces collapse to one separator.
    ["a   b", "a-b"],
    ["feature ", "feature-"],
    // Space pressed again after the substituted separator, and spaces around a typed one.
    ["feature- ", "feature-"],
    ["feature - x", "feature-x"],
    ["a-b", "a-b"],
    ["a--b", "a--b"],
    // A leading space would form a leading `-`, which git rejects: dropped.
    [" feature", "feature"],
    ["   ", ""],
    // Tabs and other control characters count as whitespace too.
    ["a\tb", "a-b"],
    ["a\u007fb", "a-b"],
    // Characters git forbids are dropped rather than substituted.
    ["a~b^c:d?e*f[g\\h", "abcdefgh"],
    ['say "hi"', "say-hi"],
    ["a@{b", "ab"],
    ["a..b", "a.b"],
    ["a//b", "a/b"],
    ["/a", "a"],
    [".a", "a"],
    ["-a", "a"],
    ["a/.b", "a/b"],
    ["a./b", "a/b"],
    // Already valid names are untouched, including Unicode.
    ["feature/login-v2", "feature/login-v2"],
    ["release/1.2.3", "release/1.2.3"],
    ["fix_bug", "fix_bug"],
    ["功能/登录", "功能/登录"],
    ["", ""],
  ])("%j → %j", (input, expected) => {
    expect(cleanUpBranchNameOnTyping(input)).toBe(expected);
  });

  it("is idempotent, so a cleaned field is stable under re-typing", () => {
    for (const s of ["a b", " a", "a  ..  b", "@{ x", "x/ /y", "- - a"]) {
      const once = cleanUpBranchNameOnTyping(s);
      expect(cleanUpBranchNameOnTyping(once)).toBe(once);
    }
  });
});
