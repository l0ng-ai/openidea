import { act } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { consoleExtension, executeScriptInView } from "./console";
import { SQL_LANGUAGE } from "./sqlLanguage";
import { executeConsole, rerunResult, useDatabase } from "./store";
import { provideToolWindowService } from "@/workbench/contributions";

const backend = vi.hoisted(() => ({ execute: vi.fn(), statements: vi.fn() }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: { ...actual.commands, dbExecute: backend.execute, dbStatements: backend.statements },
  };
});

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 24, key: index })),
    scrollToIndex: () => {},
  }),
}));

const PATH = "/p/console.sql";
const initial = useDatabase.getState();
let runs = 0;

beforeEach(() => {
  provideToolWindowService({ show: () => {} } as never);
  runs = 0;
  useProject.setState({
    project: { name: "p", root: "/p", trusted: true } as never,
    settings: { database: { inEditorResults: true } } as never,
  });
  useDatabase.setState({
    ...initial,
    loaded: true,
    sources: [{ id: "pg", name: "Local", driver: "postgres", readOnly: false }],
    completion: { pg: { defaultSchema: "public", tables: [], foreignKeys: [] } },
    consoles: { [PATH]: "pg" },
    results: [],
    inline: [],
  });
  backend.statements.mockImplementation((_id: unknown, text: string, from: number, to: number) => {
    let at = 0;
    const all = text.split(";").flatMap((part) => {
      const start = at + part.length - part.trimStart().length;
      at += part.length + 1;
      const st = part.trim();
      return st ? [{ from: start, to: start + st.length, text: st }] : [];
    });
    const picked = from === to ? all.filter((s) => s.from <= from && from <= s.to + 1) : all;
    return Promise.resolve({ status: "ok", data: picked });
  });
  backend.execute.mockImplementation((_r: unknown, _id: unknown, statements: Array<{ text: string }>) => {
    runs++;
    return Promise.resolve({
      status: "ok",
      data: statements.map((st) => ({
        statement: st,
        result: {
          statement: st.text,
          columns: [{ name: "v", typeName: "text" }],
          rows: [[`${st.text} #${runs}`]],
          affected: null,
          hasMore: false,
          elapsedMs: 1,
          executionMs: 1,
        },
        error: null,
      })),
    });
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("In-Editor Results", () => {
  it("keeps a run's result sets out of the result tabs, and re-runs them in place", async () => {
    await executeConsole(PATH, "SELECT 1; SELECT 2", 0, 18);
    const st = useDatabase.getState();
    expect(st.results).toEqual([]);
    expect(st.inline.map((r) => r.outcome.statement.text)).toEqual(["SELECT 1", "SELECT 2"]);
    const id = st.inline[0]!.id;
    await rerunResult(id);
    expect(useDatabase.getState().inline[0]!.outcome.result!.rows).toEqual([["SELECT 1 #2"]]);
    expect(useDatabase.getState().inline[0]!.id).toBe(id);
  });

  it("goes to the result tabs while the setting is off", async () => {
    useProject.setState({ settings: {} as never });
    await executeConsole(PATH, "SELECT 1", 0, 0);
    expect(useDatabase.getState().inline).toEqual([]);
    expect(useDatabase.getState().results).toHaveLength(1);
  });

  it("shows each result under its statement, replaces it on a re-run and drops it with the statement", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const doc = "SELECT 1;\nSELECT 2;\n";
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: consoleExtension({ language: SQL_LANGUAGE, path: PATH } as never),
      }),
    });
    const widgets = () => [...view.dom.querySelectorAll(".cm-openidea-db-inline")];
    const ids = () => useDatabase.getState().inline.map((r) => r.id);

    await act(async () => void (await executeConsole(PATH, view.state.doc.toString(), 0, doc.length)));
    await act(async () => {});
    expect(widgets()).toHaveLength(2);
    const [first, second] = ids();

    // Running the first statement again replaces only its own result.
    await act(async () => void (await executeConsole(PATH, view.state.doc.toString(), 0, 0)));
    await act(async () => {});
    expect(ids()).toHaveLength(2);
    expect(ids()).toContain(second);
    expect(ids()).not.toContain(first);
    expect(widgets()).toHaveLength(2);

    // Deleting the second statement closes its result.
    await act(async () => view.dispatch({ changes: { from: 10, to: 19 } }));
    await act(async () => {});
    expect(ids()).not.toContain(second);
    expect(widgets()).toHaveLength(1);
    view.destroy();
  });
});

describe("statements in flight", () => {
  it("marks what was submitted with its running time, then the outcome", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const doc = "SELECT 1;\nSELECT 2;\n";
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: consoleExtension({ language: SQL_LANGUAGE, path: PATH } as never),
      }),
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const execute = backend.execute.getMockImplementation()!;
    backend.execute.mockImplementationOnce(async (...args: unknown[]) => {
      await gate;
      return execute(...(args as Parameters<typeof execute>));
    });
    const executing = () => [...view.dom.querySelectorAll(".cm-openidea-db-executing")].map((e) => e.textContent);
    const elapsed = () => view.dom.querySelector(".cm-openidea-db-elapsed")?.textContent;

    let pending!: Promise<void>;
    await act(async () => {
      pending = executeScriptInView(view, PATH);
      await vi.waitFor(() => expect(backend.execute).toHaveBeenCalled());
    });
    expect(executing()).toEqual(["SELECT 1", "SELECT 2"]);
    expect(elapsed()).toMatch(/^Executing… \d+ ms$/);
    expect(view.dom.querySelector(".cm-openidea-db-run-executing")).not.toBeNull();

    // Typing above moves the marks with their text.
    act(() => view.dispatch({ changes: { from: 0, insert: "-- a longer note above\n" } }));
    expect(executing()).toEqual(["SELECT 1", "SELECT 2"]);

    await act(async () => {
      finish();
      await pending;
    });
    expect(executing()).toEqual([]);
    expect(elapsed()).toBeUndefined();
    // The outcomes land on the statements, not on where they were when sent.
    const lines = [...view.dom.querySelectorAll(".cm-openidea-db-gutter .cm-gutterElement")]
      .filter((e) => e.querySelector(".cm-openidea-db-run-ok"))
      .map((e) => e.getBoundingClientRect().top);
    expect(lines).toHaveLength(2);
    expect(view.dom.querySelectorAll(".cm-openidea-db-timing")).toHaveLength(2);
    expect(view.state.doc.lineAt(view.posAtDOM(view.dom.querySelector(".cm-openidea-db-timing")!)).text).toBe(
      "SELECT 1;",
    );
    view.destroy();
  });
});
