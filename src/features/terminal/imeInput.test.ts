import { Terminal } from "@xterm/xterm";
import { beforeEach, describe, expect, it } from "vitest";
import { ownTerminalInput } from "./imeInput";

/** What xterm does with the textarea, in miniature: a listener that must stay out of our commits. */
function setup() {
  const host = document.createElement("div");
  const textarea = document.createElement("textarea");
  host.append(textarea);
  document.body.append(host);
  const sent: string[] = [];
  const reached: string[] = [];
  textarea.addEventListener("input", (e) => reached.push((e as InputEvent).inputType));
  textarea.addEventListener("keydown", () => reached.push("keydown"));
  textarea.addEventListener("keypress", () => reached.push("keypress"));
  textarea.addEventListener("compositionstart", () => reached.push("compositionstart"));
  textarea.addEventListener("compositionend", () => reached.push("compositionend"));
  const dispose = ownTerminalInput({ host, textarea, send: (d) => sent.push(d) });
  return { host, textarea, sent, reached, dispose };
}

function keydown(target: EventTarget, init: { key: string; keyCode: number; isComposing?: boolean; altKey?: boolean }) {
  const e = new KeyboardEvent("keydown", { key: init.key, altKey: init.altKey, bubbles: true, cancelable: true });
  Object.defineProperty(e, "keyCode", { value: init.keyCode });
  if (init.isComposing) Object.defineProperty(e, "isComposing", { value: true });
  target.dispatchEvent(e);
  return e;
}

function keypress(target: EventTarget, key: string) {
  const e = new KeyboardEvent("keypress", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

function keyup(target: EventTarget, keyCode: number) {
  const e = new KeyboardEvent("keyup", { key: "", bubbles: true });
  Object.defineProperty(e, "keyCode", { value: keyCode });
  target.dispatchEvent(e);
  return e;
}

function input(target: EventTarget, init: { inputType: string; data?: string; isComposing?: boolean }) {
  const e = new Event("input", { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    inputType: { value: init.inputType },
    data: { value: init.data ?? null },
    composed: { value: true },
    isComposing: { value: init.isComposing ?? false },
  });
  target.dispatchEvent(e);
  return e;
}

function composition(target: EventTarget, type: string, data: string) {
  target.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
}

describe("ownTerminalInput", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("sends a commit that xterm's input-event gate would drop", () => {
    // Doubao on macOS: a 229 keydown, then insertText while the keydown is still pending —
    // CoreBrowserTerminal._inputEvent ignores exactly that and the character disappears.
    const { textarea, sent, reached } = setup();
    keydown(textarea, { key: "1", keyCode: 229, isComposing: true });
    input(textarea, { inputType: "insertText", data: "1", isComposing: true });
    expect(sent).toEqual(["1"]);
    expect(reached).toEqual([]);
  });

  it("leaves a commit the keyup already unblocked to xterm", () => {
    // Late injection with no keydown pending: xterm's own _inputEvent accepts it.
    const { textarea, sent, reached } = setup();
    keydown(textarea, { key: "1", keyCode: 229 });
    keyup(textarea, 229);
    input(textarea, { inputType: "insertText", data: "1" });
    expect(sent).toEqual([]);
    expect(reached).toEqual(["insertText"]);
  });

  it("sends every key of a fast run exactly once", () => {
    const { textarea, sent } = setup();
    for (const key of "1234567890") {
      keydown(textarea, { key, keyCode: 229 });
      input(textarea, { inputType: "insertText", data: key });
      keyup(textarea, 229);
    }
    expect(sent.join("")).toBe("1234567890");
  });

  it("sends a multi-character commit once", () => {
    const { textarea, sent } = setup();
    keydown(textarea, { key: "1", keyCode: 229 });
    input(textarea, { inputType: "insertText", data: "123" });
    expect(sent).toEqual(["123"]);
  });

  it("sends a composition commit reported without compositionstart", () => {
    const { textarea, sent } = setup();
    input(textarea, { inputType: "insertFromComposition", data: "，" });
    expect(sent).toEqual(["，"]);
  });

  it("leaves keys xterm's keydown path already sent to xterm", () => {
    const { textarea, sent, reached } = setup();
    keydown(textarea, { key: "a", keyCode: 65 });
    input(textarea, { inputType: "insertText", data: "a" });
    expect(sent).toEqual([]);
    expect(reached).toEqual(["keydown", "insertText"]);
  });

  it("leaves third-level shift characters to xterm's keypress path", () => {
    // Option+key (optionAsMeta off) / AltGr: xterm sends the character from keypress, so the
    // input event that follows must not be sent a second time.
    const { textarea, sent, reached } = setup();
    keydown(textarea, { key: "2", keyCode: 50, altKey: true });
    input(textarea, { inputType: "insertText", data: "™" });
    expect(sent).toEqual([]);
    expect(reached).toEqual(["keydown", "insertText"]);
  });

  it("leaves input with no keydown behind it to xterm", () => {
    // Dictation, an on-screen keyboard or the emoji picker.
    const { textarea, sent, reached } = setup();
    input(textarea, { inputType: "insertText", data: "😀" });
    expect(sent).toEqual([]);
    expect(reached).toEqual(["insertText"]);
  });

  it("keeps out of real compositions", () => {
    const { textarea, sent, reached } = setup();
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    keydown(textarea, { key: "Process", keyCode: 229, isComposing: true });
    input(textarea, { inputType: "insertCompositionText", data: "你", isComposing: true });
    expect(sent).toEqual([]);
    expect(reached).toEqual(["compositionstart", "keydown", "insertCompositionText"]);
  });

  it("keeps the input-source switch from ending a composition early", () => {
    // CapsLock with macOS Pinyin: xterm would send the composition on this keydown and again on
    // compositionend.
    const { textarea, reached } = setup();
    composition(textarea, "compositionstart", "");
    keydown(textarea, { key: "CapsLock", keyCode: 20, isComposing: true });
    keydown(textarea, { key: "Unidentified", keyCode: 0, isComposing: true });
    expect(reached).toEqual(["compositionstart", "keydown"]);
  });

  it.each([
    ["aw d", "awd"],
    ["claude co de", "claudecode"],
    ["xi'an", "xi'an"],
  ])("commits the letters typed for %j without the IME's syllable spaces", (shown, typed) => {
    const { textarea } = setup();
    textarea.value = "ls ";
    composition(textarea, "compositionstart", "");
    composition(textarea, "compositionupdate", shown);
    textarea.value = `ls ${shown}`;
    composition(textarea, "compositionend", shown);
    expect(textarea.value).toBe(`ls ${typed}`);
  });

  it.each([
    ["ni hao", "你好"],
    ["helloworld", "hello world"],
  ])("keeps a candidate chosen for %j as committed", (shown, chosen) => {
    const { textarea } = setup();
    composition(textarea, "compositionstart", "");
    composition(textarea, "compositionupdate", shown);
    textarea.value = chosen;
    composition(textarea, "compositionend", chosen);
    expect(textarea.value).toBe(chosen);
  });

  it("stops an IME keydown and its keypress before xterm sees them", () => {
    const { textarea, reached } = setup();
    keydown(textarea, { key: "1", keyCode: 229 });
    keypress(textarea, "1");
    expect(reached).toEqual([]);
  });

  it("clears the textarea after a commit", () => {
    const { textarea } = setup();
    textarea.value = "1";
    keydown(textarea, { key: "1", keyCode: 229 });
    input(textarea, { inputType: "insertText", data: "1" });
    expect(textarea.value).toBe("");
  });

  it("stops listening once disposed", () => {
    const { textarea, sent, dispose } = setup();
    dispose();
    keydown(textarea, { key: "1", keyCode: 229 });
    input(textarea, { inputType: "insertText", data: "1" });
    expect(sent).toEqual([]);
  });
});

describe("ownTerminalInput with xterm", () => {
  type Step =
    | ["keydown" | "keyup", string, number, boolean?]
    | ["compositionstart" | "compositionupdate" | "compositionend", string]
    | ["input", string, string | null, string];

  /** Replays a WKWebView event trace on xterm's textarea, setting the value the IME left. */
  async function replay(steps: Step[]) {
    const host = document.createElement("div");
    document.body.append(host);
    const term = new Terminal();
    term.open(host);
    const textarea = term.textarea!;
    const sent: string[] = [];
    term.onData((d) => sent.push(d));
    ownTerminalInput({ host, textarea, send: (d) => sent.push(d) });
    const task = () => new Promise((resolve) => setTimeout(resolve, 0));
    for (const step of steps) {
      if (step[0] === "keydown") {
        const e = keydown(textarea, { key: step[1], keyCode: step[2], isComposing: step[3] });
        // A browser fires no keypress for a keydown xterm cancelled.
        if (!step[3] && !e.defaultPrevented && step[1].length === 1) keypress(textarea, step[1]);
      } else if (step[0] === "keyup") {
        keyup(textarea, step[2]);
      } else if (step[0] === "input") {
        textarea.value = step[3];
        input(textarea, { inputType: step[1], data: step[2] ?? undefined, isComposing: step[1] !== "insertText" });
      } else {
        composition(textarea, step[0], step[1]);
      }
      await task();
    }
    await task();
    term.dispose();
    return sent;
  }

  function composeThenSwitch(before: string, shown: string[]): Step[] {
    const steps: Step[] = [["compositionstart", ""]];
    for (const text of shown) {
      steps.push(
        ["compositionupdate", text],
        ["input", "insertCompositionText", text, before + text],
        ["keydown", text.at(-1)!, 229, true],
        ["keyup", text.at(-1)!, text.toUpperCase().charCodeAt(text.length - 1), true],
      );
    }
    const committed = shown.at(-1)!;
    steps.push(
      ["keydown", "CapsLock", 20, true],
      ["keydown", "Unidentified", 0, true],
      ["input", "deleteCompositionText", null, before],
      ["input", "insertFromComposition", committed, before + committed],
      ["compositionend", committed],
      ["keyup", "CapsLock", 20],
    );
    return steps;
  }

  it("sends what was typed once when macOS Pinyin switches to English mid-composition", async () => {
    // Safari trace: `awd` in Pinyin, CapsLock, `cl` in English, CapsLock, `claudecode` in Pinyin,
    // CapsLock. Before: "aw d" and "claude code" were each sent twice.
    const sent = await replay([
      ...composeThenSwitch("", ["a", "a w", "aw d"]),
      ["keydown", "c", 67],
      ["input", "insertText", "c", "awdc"],
      ["keyup", "c", 67],
      ["keydown", "l", 76],
      ["input", "insertText", "l", "awdcl"],
      ["keyup", "l", 76],
      ["keydown", "CapsLock", 20],
      ["keydown", "Unidentified", 0],
      ["keyup", "CapsLock", 20],
      ...composeThenSwitch("awdcl", [
        "c",
        "c l",
        "c la",
        "cl au",
        "claud",
        "claude",
        "claude c",
        "claude co",
        "claude co d",
        "claude code",
      ]),
    ]);
    expect(sent).toEqual(["awd", "c", "l", "claudecode"]);
  });
});
