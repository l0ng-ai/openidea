import { beforeEach, describe, expect, it } from "vitest";
import { editorKeyName } from "./editorKeys";
import {
  _reloadMacros,
  deleteMacro,
  describeStep,
  playSteps,
  recordStep,
  renameMacro,
  saveMacro,
  startRecording,
  stopRecording,
  storableArg,
  STORAGE_KEY,
  useMacros,
} from "./model";

beforeEach(() => {
  localStorage.clear();
  _reloadMacros();
});

describe("macros", () => {
  it("records actions, merged typing and keys only while recording", () => {
    recordStep({ kind: "text", text: "ignored" });
    startRecording();
    recordStep({ kind: "text", text: "he" });
    recordStep({ kind: "text", text: "llo" });
    recordStep({ kind: "key", key: "Enter" });
    recordStep({ kind: "action", id: "editor.duplicateLine" });
    const steps = stopRecording();
    expect(steps).toEqual([
      { kind: "text", text: "hello" },
      { kind: "key", key: "Enter" },
      { kind: "action", id: "editor.duplicateLine" },
    ]);
    expect(useMacros.getState().last).toEqual(steps);
    // An empty recording keeps the last macro.
    startRecording();
    stopRecording();
    expect(useMacros.getState().last).toEqual(steps);
  });

  it("persists saved macros; renames and deletes them", () => {
    saveMacro("Dup", [{ kind: "action", id: "editor.duplicateLine" }]);
    saveMacro("Two", []);
    expect(renameMacro("Dup", "Two")).toBe(false);
    expect(renameMacro("Dup", "Duplicate")).toBe(true);
    _reloadMacros();
    expect(useMacros.getState().saved.map((m) => m.name)).toEqual(["Duplicate", "Two"]);
    deleteMacro("Two");
    _reloadMacros();
    expect(useMacros.getState().saved.map((m) => m.name)).toEqual(["Duplicate"]);
  });

  it("drops malformed stored steps", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        last: [{ kind: "text", text: "a" }, { kind: "action" }, { kind: "action", id: "x", arg: { a: { b: 1 } } }],
        saved: [{ name: "" }],
      }),
    );
    _reloadMacros();
    expect(useMacros.getState().last).toEqual([{ kind: "text", text: "a" }]);
    expect(useMacros.getState().saved).toEqual([]);
  });

  it("plays steps in order and stops at the first that cannot run; nothing is recorded meanwhile", async () => {
    const log: string[] = [];
    startRecording();
    const ok = await playSteps(
      [
        { kind: "action", id: "a", arg: 1 },
        { kind: "text", text: "t" },
        { kind: "key", key: "Tab" },
        { kind: "action", id: "b" },
      ],
      {
        action: async (id, arg) => {
          recordStep({ kind: "action", id });
          log.push(`${id}${arg ?? ""}`);
          return id !== "b";
        },
        text: (t) => (log.push(t), true),
        key: (k) => (log.push(k), true),
      },
    );
    expect(ok).toBe(false);
    expect(log).toEqual(["a1", "t", "Tab", "b"]);
    expect(useMacros.getState().recording).toEqual([]);
    expect(useMacros.getState().playing).toBe(false);
  });

  it("stores plain action arguments only and describes steps", () => {
    expect(storableArg("x")).toBe("x");
    expect(storableArg(2)).toBe(2);
    expect(storableArg(undefined)).toBeUndefined();
    expect(storableArg(Number.NaN)).toBeNull();
    const title = (id: string) => (id === "a" ? "Action A" : id);
    expect(describeStep({ kind: "action", id: "a", arg: "x" }, title)).toBe("Action A (x)");
    expect(describeStep({ kind: "text", text: "a\nb" }, title)).toBe('Type "a↵b"');
    expect(describeStep({ kind: "key", key: "Enter" }, title)).toBe("Press Enter");
  });

  it("stores a selection payload and rejects anything that is not plain data", () => {
    const selection = { path: "/a", paths: ["/a", "/b"] };
    expect(storableArg(selection)).toEqual(selection);
    expect(storableArg(["/a"])).toEqual(["/a"]);
    expect(storableArg(true)).toBe(true);
    expect(storableArg({ a: { b: 1 } })).toBeNull();
    expect(storableArg([1])).toBeNull();
    expect(storableArg(new Date())).toBeNull();
    expect(storableArg(() => 1)).toBeNull();
    expect(storableArg({ n: Number.NaN })).toBeNull();
    expect(storableArg(Object.create(null))).toEqual({});
  });

  it("round-trips an object argument through storage and describes it", () => {
    const arg = { path: "/a", paths: ["/a", "/b"] };
    saveMacro("Sel", [{ kind: "action", id: "p.run", arg }]);
    _reloadMacros();
    expect(useMacros.getState().saved[0]?.steps).toEqual([{ kind: "action", id: "p.run", arg }]);
    expect(describeStep({ kind: "action", id: "p.run", arg }, (id) => id)).toBe("p.run (/a)");
    expect(describeStep({ kind: "action", id: "p.run", arg: ["/a", "/b"] }, (id) => id)).toBe("p.run (/a, /b)");
    expect(describeStep({ kind: "action", id: "p.run", arg: { n: 1 } }, (id) => id)).toBe('p.run ({"n":1})');
  });

  it("names the editor keys a macro records", () => {
    const k = (key: string, mods: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>> = {}) =>
      editorKeyName({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
    expect(k("Enter")).toBe("Enter");
    expect(k("ArrowLeft", { shiftKey: true, altKey: true })).toBe("Alt+Shift+ArrowLeft");
    expect(k("a")).toBeNull();
    expect(k("s", { metaKey: true })).toBeNull();
  });
});
