import { afterEach, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { openideaTheme } from "./theme";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

it("shrinks hover tooltip sections near the window edge instead of spilling past the popup", () => {
  view = new EditorView({
    state: EditorState.create({ extensions: [openideaTheme] }),
    parent: document.body,
  });
  // The DOM CodeMirror builds: the hover host wraps one section per tooltip.
  const host = document.createElement("div");
  host.className = "cm-tooltip cm-tooltip-hover";
  const section = document.createElement("div");
  section.className = "cm-tooltip-section";
  host.appendChild(section);
  view.dom.appendChild(host);
  const hostStyle = getComputedStyle(host);
  expect(hostStyle.display).toBe("flex");
  expect(hostStyle.flexDirection).toBe("column");
  // `min-height: 0` releases the section from the flex minimum so it can shrink and scroll.
  expect(getComputedStyle(section).minHeight).toBe("0px");
});
