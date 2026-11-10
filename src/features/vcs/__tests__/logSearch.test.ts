import { describe, expect, it } from "vitest";
import type { Commit } from "@/bindings";
import { nextSpeedMatch, speedMatches, visibleCommitText } from "../logSearch";
import { DEFAULT_LOG_OPTIONS } from "../logOptions";
const c = (id: string): Commit => ({
  id,
  shortId: id,
  summary: "Synchronize client",
  message: "body-only",
  author: "Unique author",
  email: "hidden@example.com",
  refs: ["main"],
  parents: [],
  timeMs: 0,
});
describe("log speed search", () => {
  it("matches fuzzy words within visible columns and cycles in both directions", () => {
    const commits = [c("one"), c("two")];
    expect(speedMatches("snc clt", visibleCommitText(commits[0]!, DEFAULT_LOG_OPTIONS))).toBe(true);
    expect(nextSpeedMatch(commits, "client", DEFAULT_LOG_OPTIONS, 0)).toBe(1);
    expect(nextSpeedMatch(commits, "client", DEFAULT_LOG_OPTIONS, 1)).toBe(0);
    expect(nextSpeedMatch(commits, "client", DEFAULT_LOG_OPTIONS, 0, -1)).toBe(1);
    expect(speedMatches("Unique", visibleCommitText(commits[0]!, { ...DEFAULT_LOG_OPTIONS, showAuthor: false }))).toBe(
      false,
    );
    expect(speedMatches("body-only", visibleCommitText(commits[0]!, DEFAULT_LOG_OPTIONS))).toBe(false);
  });
});
