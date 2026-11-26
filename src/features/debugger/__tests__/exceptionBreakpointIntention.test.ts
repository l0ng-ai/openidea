import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ExceptionClassRef } from "@/bindings";

const lspExceptionClassAt = vi.fn();
const cancelRequest = vi.fn(async () => ({ status: "ok" as const, data: null }));
vi.mock("@/platform/ipc", async (orig) => {
  const actual = await orig<typeof import("@/platform/ipc")>();
  return { ...actual, isTauri: () => true, commands: { ...actual.commands, lspExceptionClassAt, cancelRequest } };
});

const { contributedIntentionsAsync } = await import("@/editor/api");
const { exceptionBreakpointIntention } = await import("../editor/exceptionBreakpointIntention");
const {
  addExceptionClass,
  loadExceptionClasses,
  removeAllExceptionClasses,
  updateExceptionClass,
  useExceptionClasses,
} = await import("../breakpoints/exceptionClasses");

const FAILURE: ExceptionClassRef = { qualifiedName: "app.Main$Failure", displayName: "Failure" };
const text = "class Main {\n  void f() { throw new Failure(); }\n}\n";

const views: EditorView[] = [];
const editor = (language = "java", caret = text.indexOf("Failure")) => {
  const ctx = { doc: 7, path: "/p/Main.java", language, uiMode: null, readOnly: false };
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: { anchor: caret },
      extensions: exceptionBreakpointIntention(ctx),
    }),
  });
  views.push(view);
  return view;
};
const offered = (view: EditorView) => contributedIntentionsAsync(view, new AbortController().signal);
const answer = (data: ExceptionClassRef | null) => lspExceptionClassAt.mockResolvedValue({ status: "ok", data });

beforeEach(() => {
  localStorage.clear();
  loadExceptionClasses("/p");
  removeAllExceptionClasses();
});
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  vi.clearAllMocks();
});

describe("Create / Enable / Disable exception breakpoint (IDEA's intention)", () => {
  it("asks the language server about the caret, in UTF-16 line and column", async () => {
    answer(FAILURE);
    await offered(editor());
    expect(lspExceptionClassAt).toHaveBeenCalledWith(expect.any(Number), 7, { line: 1, col: 23 });
  });

  it("creates a breakpoint on caught and uncaught throws of the class", async () => {
    answer(FAILURE);
    const [action] = await offered(editor());
    expect(action).toMatchObject({ label: "Create exception breakpoint on Failure", icon: "breakpoint-exception" });
    await action!.run();
    expect(useExceptionClasses.getState().list).toEqual([
      expect.objectContaining({ className: "app.Main$Failure", caught: true, uncaught: true, enabled: true }),
    ]);
  });

  it("disables an enabled breakpoint on the class and enables a disabled one, never removing it", async () => {
    answer(FAILURE);
    const bp = addExceptionClass("app.Main$Failure");
    const view = editor();
    const [disable] = await offered(view);
    expect(disable!.label).toBe("Disable exception breakpoint on Failure");
    await disable!.run();
    expect(useExceptionClasses.getState().list).toEqual([expect.objectContaining({ id: bp.id, enabled: false })]);
    const [enable] = await offered(view);
    expect(enable!.label).toBe("Enable exception breakpoint on Failure");
    await enable!.run();
    expect(useExceptionClasses.getState().list).toEqual([expect.objectContaining({ id: bp.id, enabled: true })]);
  });

  it("acts on the first breakpoint of the class, as IDEA does", async () => {
    answer(FAILURE);
    const first = addExceptionClass("app.Main$Failure");
    updateExceptionClass(first.id, { enabled: false });
    const second = addExceptionClass("app.Main$Failure");
    const [action] = await offered(editor());
    expect(action!.label).toBe("Enable exception breakpoint on Failure");
    await action!.run();
    expect(useExceptionClasses.getState().list.map((b) => [b.id, b.enabled])).toEqual([
      [first.id, true],
      [second.id, true],
    ]);
  });

  it("offers nothing where the caret names no exception class", async () => {
    answer(null);
    expect(await offered(editor())).toEqual([]);
  });

  it("is not offered outside Java", async () => {
    answer(FAILURE);
    expect(await offered(editor("kotlin"))).toEqual([]);
    expect(lspExceptionClassAt).not.toHaveBeenCalled();
  });

  it("cancels the request when the answer is no longer wanted", async () => {
    lspExceptionClassAt.mockImplementation(() => new Promise(() => {}));
    const asked = new AbortController();
    const pending = contributedIntentionsAsync(editor(), asked.signal);
    await vi.waitFor(() => expect(lspExceptionClassAt).toHaveBeenCalled());
    asked.abort();
    expect(await pending).toEqual([]);
    expect(cancelRequest).toHaveBeenCalledWith(lspExceptionClassAt.mock.calls[0]![0]);
  });
});
