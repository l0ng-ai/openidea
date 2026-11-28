import { describe, expect, it } from "vitest";
import { useContributions } from "@/workbench/contributions";
import { COMBINED_DIFF_KIND } from "../allInOneDiff";
import { DIFF_KIND } from "../diffInput";
import { activateDiffViewer } from "../diffViewer";

describe("diff editor kinds", () => {
  it("stay mounted while hidden, so switching back keeps the scroll position", () => {
    const deactivate = activateDiffViewer();
    try {
      const kinds = useContributions.getState().editorKinds;
      expect(kinds.get(DIFF_KIND)?.keepAlive).toBe(true);
      expect(kinds.get(COMBINED_DIFF_KIND)?.keepAlive).toBe(true);
    } finally {
      deactivate();
    }
  });
});
