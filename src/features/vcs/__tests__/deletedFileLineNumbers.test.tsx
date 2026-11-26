import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { EditorInput } from "@/workbench/contributions";

const texts: Record<string, string> = { HEAD: "a\nb\nc\n" };

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      fsProbe: () => Promise.resolve({ status: "ok", data: { size: 0, binary: false, tooLarge: false } }),
      vcsFileAt: (_path: string, rev: string) => Promise.resolve({ status: "ok", data: texts[rev] }),
    },
  };
});

import { DiffEditor } from "../DiffEditor";

const input = {
  kind: "diff",
  key: "diff:deleted",
  data: {
    path: "/p/a.ts",
    left: { type: "rev", rev: "HEAD" },
    right: { type: "text", text: "", label: "(deleted)", absent: true },
  },
} as unknown as EditorInput;

/** Plain gutter numbers rendered for document lines (skipping the hidden width-calibration spacer). */
const gutterNumbers = (container: HTMLElement) =>
  [...container.querySelectorAll(".cm-lineNumbers .cm-gutterElement")]
    .filter((n) => (n as HTMLElement).style.visibility !== "hidden")
    .map((n) => n.textContent)
    .filter((t) => t && /^\d+$/.test(t));

describe("line numbers of a deleted file's diff", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("shows the original text as the document itself, numbered like an editor", async () => {
    const mounted = render(<DiffEditor input={input} />);
    try {
      await waitFor(() => expect(mounted.container.querySelectorAll(".cm-editor")).toHaveLength(1));
      // "a\nb\nc\n" is four CodeMirror lines, the last one empty, as in the editor itself.
      await waitFor(() => expect(gutterNumbers(mounted.container)).toEqual(["1", "2", "3", "4"]));
      const lines = [...mounted.container.querySelectorAll(".cm-content > .cm-line")].map((l) => l.textContent);
      expect(lines).toEqual(["a", "b", "c", ""]);
      // No mirrored widget numbers: the lines are real, so the gutter, selection and context
      // menu behave like the editor's.
      expect(mounted.container.querySelector(".cm-diffWidgetNumber")).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it("keeps the document's own numbers for an added file", async () => {
    const added = {
      ...input,
      data: {
        path: "/p/a.ts",
        left: { type: "text", text: "", label: "(does not exist)", absent: true },
        right: { type: "rev", rev: "HEAD" },
      },
    } as unknown as EditorInput;
    texts.HEAD = "a\nb\nc\n";
    const mounted = render(<DiffEditor input={added} />);
    try {
      await waitFor(() => expect(mounted.container.querySelectorAll(".cm-editor")).toHaveLength(1));
      await waitFor(() => expect(gutterNumbers(mounted.container)).toContain("3"));
    } finally {
      mounted.unmount();
    }
  });
});
