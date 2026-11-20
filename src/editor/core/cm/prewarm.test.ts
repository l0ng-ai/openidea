import { afterEach, expect, it, vi } from "vitest";
import { registerEditorContribution } from "@/editor/api";
import { prewarmEditor } from "./prewarm";

afterEach(() => vi.unstubAllGlobals());

it("builds an off-screen editor with embedded contributions only, then removes it", () => {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => ((frame = f), 1));
  const seen: string[] = [];
  const offEmbedded = registerEditorContribution({
    id: "test.embedded",
    embedded: true,
    extensions: (ctx) => (seen.push(`embedded ${ctx.doc}`), []),
  });
  const offFile = registerEditorContribution({
    id: "test.file",
    extensions: () => (seen.push("file"), []),
  });
  try {
    prewarmEditor();
    expect(document.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(seen).toEqual(["embedded -1"]);
    frame!(0);
    expect(document.querySelector(".cm-editor")).toBeNull();
    expect(document.body.children).toHaveLength(0);
  } finally {
    offEmbedded();
    offFile();
  }
});
