/**
 * Delivers the IME commits xterm loses, and leaves everything else to xterm.
 *
 * `CoreBrowserTerminal._inputEvent` ignores an `insertText` event when it is `composed` and
 * a keydown is still pending (`_keyDownSeen`). That is right for keys xterm already sent
 * from keydown or keypress (plain typing, Option/AltGr characters), but IMEs that commit
 * without composition events (Doubao on macOS) inject their text asynchronously while the
 * keydown that started the commit is still waiting for its keyup, so the commit is dropped.
 * `CompositionHelper` has the same problem from the other side: it reads a keyCode-229
 * commit from a `setTimeout(0)` snapshot diff of the textarea, which misses text inserted
 * after the timer and emits DEL when an IME clears the textarea first.
 *
 * So only the commits xterm would lose are taken over:
 * - a keyCode-229 keydown never reaches xterm, so its deferred textarea diff cannot run;
 * - while such a keydown is pending, an `insertText` is sent from the event's own `data`
 *   (not from a value diff), then the textarea is cleared;
 * - composition input that arrives without a `compositionstart` is sent the same way.
 *
 * Everything else stays xterm's: real compositions (`compositionstart` … `compositionend`),
 * input events for keys xterm already sent, and input with no IME keydown behind it.
 */
import { isImeKey } from "@/platform/ime";

/** Commit-shaped input events that xterm's own input path ignores entirely. */
const COMPOSITION_COMMITS = new Set(["insertFromComposition", "insertCompositionText"]);

export interface TerminalInputOptions {
  /** The xterm host; capturing here keeps xterm's textarea listeners out of our commits. */
  host: HTMLElement;
  textarea: HTMLTextAreaElement;
  send: (data: string) => void;
}

/**
 * Takes input-method commits away from xterm's textarea handling. Returns a disposer.
 *
 * `send` receives the committed text once per commit, in order; it is never called for
 * input a real composition produced (xterm sends that), nor for input xterm handles itself.
 */
export function ownTerminalInput({ host, textarea, send }: TerminalInputOptions): () => void {
  let composing = false;
  /** The pending keydown went to the input method, so its keypress belongs to it too. */
  let imeKey = false;
  /** An IME keydown was seen since the last keyup: its commit is ours to deliver. */
  let imeDown = false;

  const onKeyDown = (e: KeyboardEvent) => {
    if (composing) return;
    imeKey = isImeKey(e);
    if (imeKey) {
      // The IME owns this key: xterm must not run its deferred textarea diff or send the
      // keypress, and the text it commits next is ours.
      imeDown = true;
      e.stopPropagation();
    }
  };

  // xterm emits a pressed character from keypress; for an IME key that would duplicate the
  // text the input event delivers.
  const onKeyPress = (e: KeyboardEvent) => {
    if (imeKey) e.stopPropagation();
  };

  const onKeyUp = () => {
    imeKey = false;
    imeDown = false;
  };

  const onInput = (e: InputEvent) => {
    if (composing || !e.data) return;
    if (e.inputType === "insertText") {
      // Without an IME keydown behind it this is xterm's: it drops the event for a key it
      // already sent (Option/AltGr, plain typing) and delivers the rest (dictation, emoji).
      if (!imeDown) return;
    } else if (!COMPOSITION_COMMITS.has(e.inputType)) {
      return;
    }
    e.stopPropagation();
    send(e.data);
    textarea.value = "";
  };

  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
  };

  host.addEventListener("keydown", onKeyDown, true);
  host.addEventListener("keypress", onKeyPress, true);
  host.addEventListener("input", onInput, true);
  host.addEventListener("keyup", onKeyUp, true);
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);
  return () => {
    host.removeEventListener("keydown", onKeyDown, true);
    host.removeEventListener("keypress", onKeyPress, true);
    host.removeEventListener("input", onInput, true);
    host.removeEventListener("keyup", onKeyUp, true);
    textarea.removeEventListener("compositionstart", onCompositionStart);
    textarea.removeEventListener("compositionend", onCompositionEnd);
  };
}
