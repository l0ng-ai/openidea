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
 *
 * A real composition still needs two corrections before xterm sends it:
 * - switching the input source mid-composition (CapsLock with macOS Pinyin) reports a
 *   keyCode-0 keydown before `compositionend`; xterm takes it for a key that ends the
 *   composition and sends the text at once, then sends it again on `compositionend`;
 * - the letters committed by that switch keep the spaces the IME showed between syllables
 *   (`awd` arrives as `aw d`), so the textarea is rewritten to what was typed.
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
 * The text a composition commits, without the syllable spaces an IME displays when it commits
 * its raw letters (the commit is the composition text itself and plain ASCII). The user never
 * typed those spaces: Space picks a candidate while composing.
 */
function typedCommit(commit: string, composition: string): string {
  if (commit !== composition || !/^[\x20-\x7e]+$/.test(commit)) return commit;
  return commit.replaceAll(" ", "");
}

/**
 * Takes input-method commits away from xterm's textarea handling. Returns a disposer.
 *
 * `send` receives the committed text once per commit, in order; it is never called for
 * input a real composition produced (xterm sends that), nor for input xterm handles itself.
 */
export function ownTerminalInput({ host, textarea, send }: TerminalInputOptions): () => void {
  let composing = false;
  /** The composition text the IME displays, from the last `compositionupdate`. */
  let composition = "";
  /** The pending keydown went to the input method, so its keypress belongs to it too. */
  let imeKey = false;
  /** The pending key belongs to an IME: its commit is ours to deliver. */
  let imeDown = false;

  const onKeyDown = (e: KeyboardEvent) => {
    if (composing) {
      // The input-source switch, not a key: the commit follows on `compositionend`.
      if (e.keyCode === 0) e.stopPropagation();
      return;
    }
    imeKey = isImeKey(e);
    imeDown = imeKey;
    if (imeKey) {
      // The IME owns this key: xterm must not run its deferred textarea diff or send the
      // keypress, and the text it commits next is ours.
      e.stopPropagation();
    }
  };

  // xterm emits a pressed character from keypress; for an IME key that would duplicate the
  // text the input event delivers.
  const onKeyPress = (e: KeyboardEvent) => {
    // Telex tools on macOS post a retyped `ông` as one key event. xterm builds its keypress
    // text from `charCode`, which holds only `ô`, so the input event must deliver this one.
    if (!composing && e.key.length > 1 && e.key !== "Enter") imeKey = imeDown = true;
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
    composition = "";
  };
  const onCompositionUpdate = (e: CompositionEvent) => {
    composition = e.data;
  };
  // Runs before xterm reads the commit from the textarea, which it defers by a task.
  const onCompositionEnd = (e: CompositionEvent) => {
    composing = false;
    const commit = typedCommit(e.data, composition);
    if (commit !== e.data && textarea.value.endsWith(e.data)) {
      textarea.value = textarea.value.slice(0, -e.data.length) + commit;
    }
  };

  host.addEventListener("keydown", onKeyDown, true);
  host.addEventListener("keypress", onKeyPress, true);
  host.addEventListener("input", onInput, true);
  host.addEventListener("keyup", onKeyUp, true);
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionupdate", onCompositionUpdate);
  textarea.addEventListener("compositionend", onCompositionEnd);
  return () => {
    host.removeEventListener("keydown", onKeyDown, true);
    host.removeEventListener("keypress", onKeyPress, true);
    host.removeEventListener("input", onInput, true);
    host.removeEventListener("keyup", onKeyUp, true);
    textarea.removeEventListener("compositionstart", onCompositionStart);
    textarea.removeEventListener("compositionupdate", onCompositionUpdate);
    textarea.removeEventListener("compositionend", onCompositionEnd);
  };
}
