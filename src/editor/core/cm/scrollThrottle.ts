/**
 * Marks the editor with a `cm-scrolling` class while the user is actively
 * scrolling; expensive decorations (sticky header, indent guides) keep
 * their previous paint and defer re-measuring until the wheel / trackpad
 * rests for a moment. Keeps fast mouse-wheel scrolling from spending every
 * frame on layout work that will be stale by the next scroll event anyway.
 */
import { StateEffect, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

const IDLE_MS = 140;

/** Dispatched once a scroll burst ends so plugins that skipped work can catch up. */
export const scrollSettled = StateEffect.define<null>();

class ScrollThrottle {
  private timer = 0;
  private active = false;

  constructor(private view: EditorView) {
    // Run before bubble listeners, including stickyScroll when it was
    // installed first, so the very first event is throttled too.
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true, capture: true });
  }

  private onScroll = () => {
    if (!this.active) {
      this.active = true;
      this.view.dom.classList.add("cm-scrolling");
    }
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.active = false;
      this.view.dom.classList.remove("cm-scrolling");
      // Wake plugins that suppressed viewport work during the burst.
      this.view.dispatch({ effects: scrollSettled.of(null) });
    }, IDLE_MS);
  };

  destroy() {
    clearTimeout(this.timer);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll, true);
    this.view.dom.classList.remove("cm-scrolling");
  }
}

/** Check whether an update marks the end of a scroll burst. */
export function isScrollSettled(u: ViewUpdate): boolean {
  return u.transactions.some((tr) => tr.effects.some((e) => e.is(scrollSettled)));
}

export const scrollThrottle: Extension = ViewPlugin.fromClass(ScrollThrottle);
