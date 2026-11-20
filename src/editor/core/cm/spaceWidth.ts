/**
 * The editor font's space width, published on the scroller as `--openidea-space`
 * for anything laid out in columns of indentation (indent guides, code lens rows,
 * rendered doc comments). A space is measured, not `ch`: in a proportional font it
 * is narrower than "0". The probe's text is fixed, so the value only changes with
 * the font, its size or zoom; `defaultCharacterWidth` is sampled from whichever
 * line is in view and drifts while scrolling, and an inherited variable that
 * changes restyles every line.
 */
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** One column of indentation, as a CSS length. */
export const SPACE = "var(--openidea-space, 1ch)";

const SAMPLE = 64;

/** Shared by every extension that lays out by `SPACE`; CodeMirror installs it once. */
export const spaceWidth = ViewPlugin.fromClass(
  class {
    private probe: HTMLElement;
    private written = "";
    constructor(readonly view: EditorView) {
      // Inherits the editor font from the scroller, outside the content CodeMirror observes.
      this.probe = document.createElement("span");
      this.probe.setAttribute("aria-hidden", "true");
      this.probe.style.cssText = "position: absolute; top: 0; left: 0; visibility: hidden; white-space: pre";
      this.probe.textContent = " ".repeat(SAMPLE);
      view.scrollDOM.appendChild(this.probe);
      this.measure();
    }
    measure() {
      this.view.requestMeasure({
        key: this,
        read: (view) => this.probe.getBoundingClientRect().width / (view.scaleX || 1) / SAMPLE,
        write: (width, view) => {
          const value = `${+width.toFixed(3)}px`;
          if (width <= 0 || value === this.written) return;
          this.written = value;
          view.scrollDOM.style.setProperty("--openidea-space", value);
        },
      });
    }
    update(u: ViewUpdate) {
      if (u.geometryChanged) this.measure();
    }
    destroy() {
      this.probe.remove();
      this.view.scrollDOM.style.removeProperty("--openidea-space");
    }
  },
);
