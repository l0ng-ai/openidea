import { act } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import type { DbStatementOutcome, SqlStatement } from "@/platform/ipc";
import { consoleExtension, executeInView, executeScriptInView } from "./console";
import { SQL_LANGUAGE } from "./sqlLanguage";
import { streamExecution } from "./executeStream.fixture";
import { cancelConsole, executeConsole, rerunResult, useDatabase } from "./store";
import { provideToolWindowService } from "@/workbench/contributions";

const backend = vi.hoisted(() => ({ execute: vi.fn(), stream: vi.fn(), cancel: vi.fn(), statements: vi.fn() }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      dbExecute: backend.execute,
      dbExecuteStream: backend.stream,
      cancelRequest: backend.cancel,
      dbStatements: backend.statements,
    },
  };
});

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));

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

function queryOutcome(statement: SqlStatement, value: string, elapsedMs: number): DbStatementOutcome {
  return {
    statement,
    result: {
      statement: statement.text,
      columns: [{ name: "v", typeName: "text" }],
      rows: [[value]],
      affected: null,
      hasMore: false,
      elapsedMs,
      executionMs: elapsedMs,
    },
    error: null,
  };
}

beforeEach(() => {
  backend.stream.mockReset().mockImplementation(streamExecution(backend.execute));
  backend.cancel.mockReset().mockResolvedValue(undefined);
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
    let at = from < to ? from : 0;
    const sql = from < to ? text.slice(from, to) : text;
    const all = sql.split(";").flatMap((part) => {
      const start = at + part.length - part.trimStart().length;
      at += part.length + 1;
      const st = part.trim();
      return st ? [{ from: start, to: start + st.length, text: st }] : [];
    });
    const picked = from === to ? all.filter((s) => s.from <= from && from <= s.to + 1) : all;
    return Promise.resolve({ status: "ok", data: picked });
  });
  backend.execute.mockImplementation((_r: unknown, _id: unknown, statements: SqlStatement[]) => {
    runs++;
    return Promise.resolve({
      status: "ok",
      data: statements.map((st) => queryOutcome(st, `${st.text} #${runs}`, 1)),
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
  it.each(["selection", "script"])("shows the current statement and publishes results during a %s", async (mode) => {
    useProject.setState({ settings: {} as never });
    const doc = "SELECT 1;\nUPDATE t SET n = 2;\nSELECT 3;";
    const parent = document.body.appendChild(document.createElement("div"));
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: 0, head: mode === "selection" ? doc.length : 0 },
        extensions: consoleExtension({ language: SQL_LANGUAGE, path: PATH } as never),
      }),
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    backend.stream.mockImplementationOnce(async (_r, _id, statements: SqlStatement[], _max, _schema, channel) => {
      channel.onmessage({ type: "started", index: 0 });
      channel.onmessage({ type: "completed", index: 0, outcome: queryOutcome(statements[0]!, "first", 500) });
      channel.onmessage({ type: "started", index: 1 });
      await gate;
      const update = queryOutcome(statements[1]!, "", 2500);
      channel.onmessage({
        type: "completed",
        index: 1,
        outcome: { ...update, result: { ...update.result!, columns: [], rows: [], affected: 1 } },
      });
      channel.onmessage({ type: "started", index: 2 });
      channel.onmessage({ type: "completed", index: 2, outcome: queryOutcome(statements[2]!, "third", 1000) });
      channel.onmessage({ type: "done", error: null });
      return { status: "ok", data: null };
    });
    const cells = () => useDatabase.getState().results.map((r) => r.outcome.result?.rows[0]?.[0]);
    const highlighted = () => [...view.dom.querySelectorAll(".cm-openidea-db-executing")].map((e) => e.textContent);
    const times = () =>
      [...view.dom.querySelectorAll(".cm-openidea-db-timing:not(.cm-openidea-db-elapsed)")].map((e) => e.textContent);
    let pending!: Promise<void>;
    try {
      await act(async () => {
        pending = mode === "selection" ? executeInView(view, PATH) : executeScriptInView(view, PATH);
        await vi.waitFor(() => expect(cells()).toEqual(["first"]));
      });
      expect(highlighted()).toEqual(["UPDATE t SET n = 2"]);
      expect(times()).toEqual(["500 ms"]);
      expect(view.dom.querySelectorAll(".cm-openidea-db-run-ok")).toHaveLength(1);

      await act(async () => {
        finish();
        await pending;
      });
      expect(cells()).toEqual(["first", "third"]);
      expect(highlighted()).toEqual([]);
      expect(times()).toEqual(["500 ms", "2.5 s", "1.0 s"]);
      expect(view.dom.querySelectorAll(".cm-openidea-db-run-ok")).toHaveLength(3);
      expect(view.state.selection.main.head).toBe(mode === "selection" ? doc.length : 0);
    } finally {
      finish();
      if (pending)
        await act(async () => {
          await pending;
        });
      view.destroy();
    }
  });

  it("clears the previous marks for a repeated selection and retains only its completed marks on cancel", async () => {
    useProject.setState({ settings: {} as never });
    const selection = "SELECT 1;\nSELECT 1;\nSELECT 1;";
    const doc = `${selection}\nBAD SQL;`;
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: { anchor: 0, head: selection.length },
        extensions: consoleExtension({ language: SQL_LANGUAGE, path: PATH } as never),
      }),
    });
    backend.execute.mockImplementationOnce(async (_r, _id, statements: SqlStatement[]) => ({
      status: "ok",
      data: statements.map((st, index) =>
        index === 3 ? { statement: st, result: null, error: "syntax error" } : queryOutcome(st, "old", 100),
      ),
    }));
    let cancel!: () => void;
    backend.stream.mockImplementationOnce(streamExecution(backend.execute));
    backend.stream.mockImplementationOnce(async (request, _id, statements: SqlStatement[], _max, _schema, channel) => {
      channel.onmessage({ type: "started", index: 0 });
      channel.onmessage({ type: "completed", index: 0, outcome: queryOutcome(statements[0]!, "new", 500) });
      channel.onmessage({ type: "started", index: 1 });
      await new Promise<void>((resolve) => {
        cancel = resolve;
        backend.cancel.mockImplementationOnce(async (id) => {
          expect(id).toBe(request);
          cancel();
        });
      });
      channel.onmessage({ type: "done", error: { kind: "cancelled", message: "Cancelled", data: null } });
      return { status: "ok", data: null };
    });
    const ok = () => view.dom.querySelectorAll(".cm-openidea-db-run-ok");
    const error = () => view.dom.querySelectorAll(".cm-openidea-db-run-error");
    const banner = () => view.dom.querySelector(".cm-openidea-db-banner");
    let pending: Promise<void> | undefined;
    try {
      await act(async () => executeScriptInView(view, PATH));
      expect(ok()).toHaveLength(3);
      expect(error()).toHaveLength(1);
      expect(banner()).not.toBeNull();

      await act(async () => {
        pending = executeInView(view, PATH);
        await vi.waitFor(() => expect(ok()).toHaveLength(1));
      });
      expect(ok()).toHaveLength(1);
      expect(error()).toHaveLength(1);
      expect(banner()).toBeNull();
      const active = view.dom.querySelector(".cm-openidea-db-executing")!;
      expect(view.state.doc.lineAt(view.posAtDOM(active)).number).toBe(2);

      await act(async () => {
        cancelConsole(PATH);
        await pending;
      });
      expect(ok()).toHaveLength(1);
      expect(error()).toHaveLength(1);
      expect(view.dom.querySelector(".cm-openidea-db-elapsed")).toBeNull();
      const tabs = useDatabase.getState().results;
      expect(new Set(tabs.map((tab) => tab.id)).size).toBe(4);
      expect(tabs.map((tab) => tab.outcome.result?.rows)).toEqual([[["old"]], [["old"]], [["old"]], [["new"]]]);
    } finally {
      cancel?.();
      await pending;
      view.destroy();
    }
  });

  it("runs SQL from a read-only editor without leaving execution progress behind", async () => {
    useProject.setState({ settings: {} as never });
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "SELECT 1;",
        extensions: [
          EditorState.readOnly.of(true),
          consoleExtension({ language: SQL_LANGUAGE, path: PATH, readOnly: true } as never),
        ],
      }),
    });
    try {
      await executeInView(view, PATH);
      const { results, running, executions } = useDatabase.getState();
      expect(results[0]?.outcome.result?.rows).toEqual([["SELECT 1 #1"]]);
      expect(running).toEqual({});
      expect(executions).toEqual({});
    } finally {
      view.destroy();
    }
  });

  it("clears execution progress if setting up editor marks fails", async () => {
    const outcomes = await executeConsole(PATH, "SELECT 1;", 0, 0, () => {
      throw new Error("Could not set up editor marks");
    });
    expect(outcomes).toEqual([]);
    const { running, executions } = useDatabase.getState();
    expect(running).toEqual({});
    expect(executions).toEqual({});
  });

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
      await vi.waitFor(() => expect(executing()).toEqual(["SELECT 1"]));
    });
    expect(elapsed()).toMatch(/^Executing… \d+ ms$/);
    expect(view.dom.querySelector(".cm-openidea-db-run-executing")).not.toBeNull();

    // Typing above moves the marks with their text.
    act(() => view.dispatch({ changes: { from: 0, insert: "-- a longer note above\n" } }));
    expect(executing()).toEqual(["SELECT 1"]);

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
