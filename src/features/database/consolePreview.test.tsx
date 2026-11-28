import { CompletionContext } from "@codemirror/autocomplete";
import { StandardSQL } from "@codemirror/lang-sql";
import { ensureSyntaxTree } from "@codemirror/language";
import { act } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { completionSource, consoleExtension, executeInView, previewRanges } from "./console";
import { SQL_LANGUAGE } from "./sqlLanguage";
import { streamExecution } from "./executeStream.fixture";
import { useDatabase } from "./store";
import { provideToolWindowService } from "@/workbench/contributions";

const backend = vi.hoisted(() => ({ execute: vi.fn(), stream: vi.fn(), statements: vi.fn() }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      dbExecute: backend.execute,
      dbExecuteStream: backend.stream,
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

/** The same split as the console's backend: a selection's statements, else the one at the caret. */
function statements(text: string, from: number, to: number) {
  let at = from < to ? from : 0;
  const sql = from < to ? text.slice(from, to) : text;
  const all = sql.split(";").flatMap((part) => {
    const start = at + part.length - part.trimStart().length;
    at += part.length + 1;
    const st = part.trim();
    return st ? [{ from: start, to: start + st.length, text: st }] : [];
  });
  return from === to ? all.filter((s) => s.from <= from && from <= s.to + 1) : all;
}

beforeEach(() => {
  backend.stream.mockReset().mockImplementation(streamExecution(backend.execute));
  provideToolWindowService({ show: () => {} } as never);
  useProject.setState({
    project: { name: "p", root: "/p", trusted: true } as never,
    settings: {} as never,
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
  backend.statements.mockImplementation((_id: unknown, text: string, from: number, to: number) =>
    Promise.resolve({ status: "ok", data: statements(text, from, to) }),
  );
  backend.execute.mockImplementation((_r: unknown, _id: unknown, submitted: Array<{ text: string }>) =>
    Promise.resolve({
      status: "ok",
      data: submitted.map((st) => ({
        statement: st,
        error: null,
        result: {
          statement: st.text,
          columns: [],
          rows: [],
          affected: null,
          hasMore: false,
          elapsedMs: 1,
          executionMs: 1,
          truncated: [],
        },
      })),
    }),
  );
});

afterEach(() => {
  document.body.innerHTML = "";
});

function makeView(doc: string, anchor: number, head = anchor) {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [StandardSQL.extension, consoleExtension({ language: SQL_LANGUAGE, path: PATH } as never)],
    }),
  });
  return view;
}

/** The text each execution-range box surrounds (jsdom has no layout to draw the boxes in). */
const bordered = (view: EditorView) => previewRanges(view.state).map((r) => view.state.sliceDoc(r.from, r.to));

it("uses DuckDB completion and highlighting only for a bound DuckDB source", async () => {
  const doc = "FROM read_parquet('sample.parquet') SELECT * EXCLUDE (\"My Col\") QUALIFY row_number() OVER () = 1";
  const view = makeView(doc, 0);
  const parsed = (kind: string) => {
    const found: string[] = [];
    ensureSyntaxTree(view.state, doc.length, 1000)?.iterate({
      enter: (n) => {
        if (n.name === kind) found.push(doc.slice(n.from, n.to));
      },
    });
    return found;
  };
  const statements = async () =>
    (await completionSource(PATH)(new CompletionContext(EditorState.create(), 0, true)))?.options.map((o) => o.label);
  try {
    useDatabase.setState({
      sources: [
        { id: "named", driver: "jdbc", vendor: "duckdb", name: "DuckDB" },
        { id: "custom", driver: "jdbc", url: " JDBC:DUCKDB:example.duckdb ", name: "Custom DuckDB" },
        { id: "other", driver: "jdbc", vendor: "postgres", url: "jdbc:postgresql://localhost/duckdb" },
      ],
      completion: Object.fromEntries(
        ["named", "custom", "other"].map((id) => [id, { defaultSchema: "main", tables: [], foreignKeys: [] }]),
      ),
    });
    const checkDuckDB = async (id: string) => {
      useDatabase.setState({ consoles: { [PATH]: id } });
      expect(parsed("Keyword")).toEqual(expect.arrayContaining(["FROM", "SELECT", "EXCLUDE", "QUALIFY", "OVER"]));
      expect(parsed("Builtin")).toEqual(["read_parquet", "row_number"]);
      expect(parsed("QuotedIdentifier")).toEqual(['"My Col"']);
      expect(await statements()).toEqual(expect.arrayContaining(["FROM", "SUMMARIZE"]));
    };
    await checkDuckDB("named");
    await checkDuckDB("custom");
    useDatabase.setState({ consoles: { [PATH]: "other" } });
    expect(parsed("Keyword")).not.toContain("QUALIFY");
    expect(await statements()).not.toContain("FROM");
  } finally {
    view.destroy();
  }
});

describe("the execution range preview", () => {
  it("borders the statement the caret is in, asking the splitter the run asks", async () => {
    const doc = "SELECT 1;\nSELECT 2;\nSELECT 3;";
    const view = makeView(doc, 13); // Inside the second statement.
    try {
      await act(async () => {});
      expect(bordered(view)).toEqual(["SELECT 2"]);
      // The same splitting request an Execute with this caret would make.
      expect(backend.statements).toHaveBeenCalledWith("pg", doc, 13, 13);
    } finally {
      view.destroy();
    }
  });

  it("borders the selected statements instead, leaving the selection alone", async () => {
    const doc = "SELECT 1;\nSELECT 2;\nSELECT 3;";
    const view = makeView(doc, 0);
    try {
      view.dispatch({ selection: { anchor: 0, head: 19 } }); // The first two statements.
      await act(async () => {});
      expect(bordered(view)).toEqual(["SELECT 1", "SELECT 2"]);
      // The preview never touched the selection.
      expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([0, 19]);

      // Back to the caret of the third statement.
      view.dispatch({ selection: { anchor: 25 } });
      await act(async () => {});
      expect(bordered(view)).toEqual(["SELECT 3"]);
      expect(view.state.selection.main.head).toBe(25);
    } finally {
      view.destroy();
    }
  });

  it("keeps the submitted range bordered while a run is in progress, then follows the caret again", async () => {
    const doc = "SELECT 1;\nSELECT 2;\nSELECT 3;";
    const view = makeView(doc, 13); // Executing the second statement.
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const execute = backend.execute.getMockImplementation()!;
    backend.execute.mockImplementationOnce(async (...args: unknown[]) => {
      await gate;
      return execute(...(args as Parameters<typeof execute>));
    });
    let pending!: Promise<void>;
    try {
      await act(async () => {
        pending = executeInView(view, PATH);
        await vi.waitFor(() => expect(view.dom.querySelector(".cm-openidea-db-executing")).not.toBeNull());
      });
      expect(bordered(view)).toEqual(["SELECT 2"]);

      // Moving the caret during the run does not move the submitted range.
      const asked = backend.statements.mock.calls.length;
      act(() => view.dispatch({ selection: { anchor: 25 } }));
      await act(async () => {});
      expect(bordered(view)).toEqual(["SELECT 2"]);
      expect(backend.statements.mock.calls.length).toBe(asked);

      await act(async () => {
        finish();
        await pending;
      });
      await act(async () => {});
      expect(bordered(view)).toEqual(["SELECT 3"]);
    } finally {
      finish();
      if (pending)
        await act(async () => {
          await pending;
        });
      view.destroy();
    }
  });

  it("waits for a pause in typing before splitting again, following the edit meanwhile", async () => {
    vi.useFakeTimers();
    const view = makeView("SELECT 1;\nSELECT 2;", 18); // After "SELECT 2".
    try {
      await act(async () => {});
      expect(bordered(view)).toEqual(["SELECT 2"]);
      const asked = backend.statements.mock.calls.length;
      for (const ch of "0, 3") act(() => view.dispatch(view.state.replaceSelection(ch)));
      await act(async () => {});
      // No request per keystroke; the border is the old one, mapped through the edits.
      expect(backend.statements.mock.calls.length).toBe(asked);
      expect(bordered(view)).toEqual(["SELECT 2"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(backend.statements.mock.calls.length).toBe(asked + 1);
      expect(bordered(view)).toEqual(["SELECT 20, 3"]);
    } finally {
      view.destroy();
      vi.useRealTimers();
    }
  });

  it("borders nothing where no statement would be submitted", async () => {
    const view = makeView("SELECT 1;\n", 10); // After the last statement.
    try {
      await act(async () => {});
      expect(bordered(view)).toEqual([]);
      // And the preview comes back once the caret is on a statement again.
      view.dispatch({ selection: { anchor: 3 } });
      await act(async () => {});
      expect(bordered(view)).toEqual(["SELECT 1"]);
    } finally {
      view.destroy();
    }
  });
});
