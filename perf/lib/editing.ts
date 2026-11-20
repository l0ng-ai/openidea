export interface EditorProbe {
  seed(path: string, text: string): void;
  openFile(path: string): Promise<void>;
  editorState(): { path: string; length: number; lines: number; head: number; line: number; word: string } | null;
  editorText(from?: number, to?: number): string | null;
  setCursor(offset: number): void;
  lineAtY(y: number): number;
}

export interface EditableSnapshot {
  kind: "editor" | "input";
  target: string;
  text: string;
  head: number;
  from: number;
  to: number;
}

export interface EditableRange {
  from: number;
  to: number;
  length: number;
}

/** Runs in the page: a key latency is not evidence that the intended editable received it. */
export function readEditable(range?: EditableRange): EditableSnapshot {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (active.selectionStart === null || active.selectionEnd === null)
      throw new Error("typing focus is not a text input");
    return {
      kind: "input",
      target: active.id || active.getAttribute("aria-label") || active.tagName,
      text: active.value,
      head: active.selectionEnd,
      from: active.selectionStart,
      to: active.selectionEnd,
    };
  }
  if (!active?.closest(".cm-content")) throw new Error("typing focus is not in the editor");
  // The app and browser fixture expose this typed, in-process observation boundary.
  const w = window as unknown as { __openideaPerf: EditorProbe };
  const state = w.__openideaPerf.editorState();
  if (!state) throw new Error("typing editor is unavailable");
  const text = w.__openideaPerf.editorText(range?.from, range ? range.to + state.length - range.length : undefined);
  if (text === null) throw new Error("typing editor is unavailable");
  const head = state.head - (range?.from ?? 0);
  return { kind: "editor", target: state.path, text, head, from: head, to: head };
}

export function assertTypedKey(before: EditableSnapshot, after: EditableSnapshot, key: string) {
  const fail = () => {
    throw new Error(`typing ${JSON.stringify(key)} did not produce the expected text and caret in ${before.target}`);
  };
  if (before.kind !== after.kind || before.target !== after.target) fail();
  const left = before.text.slice(0, before.from);
  const right = before.text.slice(before.to);
  if (before.kind === "input") {
    const from = key === "\b" && before.from === before.to ? Math.max(0, before.from - 1) : before.from;
    const inserted = key === "\b" ? "" : key;
    if (after.text !== before.text.slice(0, from) + inserted + right || after.head !== from + inserted.length) fail();
    return;
  }
  const afterLeft = after.text.slice(0, after.head);
  const afterRight = after.text.slice(after.head);
  if (key === "\b") {
    const removed = left.slice(afterLeft.length);
    const pair = ({ "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" } as Record<string, string>)[removed];
    if (
      after.head >= before.head ||
      !left.startsWith(afterLeft) ||
      !removed ||
      ([...removed].length !== 1 && !/^[\t ]+$/.test(removed)) ||
      (afterRight !== right && !(pair && right.startsWith(pair) && afterRight === right.slice(pair.length)))
    )
      fail();
    return;
  }
  // CodeMirror may adjust indentation, insert a matching bracket, or step over an auto-inserted closer.
  // All non-indentation text, the insertion point, and the remaining document must still match.
  const unindent = (text: string) => text.replace(/^[\t ]+/gm, "");
  if (after.head === before.head || unindent(afterLeft) !== unindent(left + key)) fail();
  const closers: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
  const closer = closers[key];
  const suffix = unindent(afterRight);
  const previous = unindent(right);
  if (suffix === previous) return;
  if (closer && suffix === closer + previous) return;
  if (
    /[)\]}"'`]/.test(key) &&
    right.startsWith(key) &&
    unindent(after.text) === unindent(before.text) &&
    suffix === unindent(right.slice(key.length))
  )
    return;
  if (key === "\n" && suffix === "\n" + previous) return;
  fail();
}

/** Runs in the page; shared by UI performance scenarios and code-intelligence evals. */
export async function openFileMeasured({ path, text, timeoutMs }: { path: string; text?: string; timeoutMs: number }) {
  const w = window as unknown as { __openideaPerf: EditorProbe };
  const t0 = performance.now();
  let timer: number | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`open action timed out for ${path}`)), timeoutMs);
  });
  let result: unknown;
  try {
    result = await Promise.race([w.__openideaPerf.openFile(path), expired]);
  } finally {
    window.clearTimeout(timer);
  }
  if (result === false) throw new Error(`open action failed for ${path}`);
  while (performance.now() - t0 <= timeoutMs) {
    await new Promise(requestAnimationFrame);
    const state = w.__openideaPerf.editorState();
    const content = w.__openideaPerf.editorText();
    const editor = document.activeElement?.closest(".cm-editor");
    const lines = [...(editor?.querySelectorAll<HTMLElement>(".cm-content .cm-line") ?? [])];
    if (
      state?.path === path &&
      content !== null &&
      state.length === content.length &&
      (text === undefined || content === text) &&
      lines.length &&
      lines.some((line) => line.getClientRects().length && content.includes(line.textContent ?? ""))
    ) {
      return performance.now() - t0;
    }
  }
  throw new Error(`requested editor ${path} did not show its contents`);
}
