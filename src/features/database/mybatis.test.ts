import { CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTRIBUTED_HOVER, type ContributedHover } from "@/editor/api";
import { useProject } from "@/platform/project";
import { mapperExtension } from "./mybatis";
import { useDatabase } from "./store";

const published = vi.hoisted(() => new Map<string, Array<{ message: string }>>());
vi.mock("@/editor/lsp/diagnostics", () => ({
  setFileDiagnostics: (path: string, _source: string, items: Array<{ message: string }>) => published.set(path, items),
}));

const PATH = "/p/src/main/resources/mapper/UserMapper.xml";
const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="com.example.UserMapper">
  <select id="find">
    select id, nam from users where id = #{id}
  </select>
  <select id="other">select * from orders</select>
</mapper>
`;

let view: EditorView | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  published.clear();
  useProject.setState({
    project: { name: "p", root: "/p", trusted: true } as never,
    settings: {
      database: { resolutionScopes: [{ path: "src/main/resources/mapper", dataSource: "pg", schema: "" }] },
    } as never,
  });
  const column = (name: string) => ({
    name,
    dataType: "text",
    nullable: true,
    primaryKey: name === "id",
    hasDefault: false,
  });
  useDatabase.setState({
    loaded: true,
    sources: [
      { id: "pg", name: "Local", driver: "postgres" },
      { id: "other", name: "Other", driver: "postgres" },
    ],
    consoles: {},
    consoleSchemas: {},
    completion: {
      pg: {
        defaultSchema: "public",
        tables: [{ schema: "public", name: "users", kind: "table", columns: [column("id"), column("name")] }],
        foreignKeys: [],
      },
    },
  });
});

afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
});

function open(doc: string) {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: mapperExtension({ path: PATH, language: "xml" } as never) }),
  });
  return view;
}

function completionAt(state: EditorState, pos: number): Promise<CompletionResult | null> {
  const sources = state.languageDataAt<CompletionSource>("openideaCompletion", pos);
  return Promise.resolve(sources[0]!(new CompletionContext(state, pos, true)));
}

describe("SQL in MyBatis mappers", () => {
  it("reports unresolved names of the statements against the scope's data source", () => {
    open(DOC);
    vi.advanceTimersByTime(1000);
    const messages = (published.get(PATH) ?? []).map((d) => d.message);
    expect(messages.some((m) => /nam\b/.test(m))).toBe(true);
    expect(messages.some((m) => /orders/.test(m))).toBe(true);
    expect(messages.some((m) => /users|\bid\b/.test(m))).toBe(false);
  });

  it("documents tables in the statements and nothing in the XML around them", () => {
    const v = open(DOC);
    const hover = v.state.languageDataAt<ContributedHover>(CONTRIBUTED_HOVER, 0)[0]!;
    expect(hover(v.state, DOC.indexOf("users") + 2)?.markdown).toMatch(/users/);
    expect(hover(v.state, DOC.indexOf("namespace") + 2)).toBeNull();
  });

  it("completes columns inside a statement only", async () => {
    const doc = DOC.replace("select id, nam from users", "select n from users");
    const v = open(doc);
    const result = await completionAt(v.state, doc.indexOf("select n") + "select n".length);
    expect(result?.options.map((o) => o.label)).toContain("name");
    expect(await completionAt(v.state, doc.indexOf("namespace") + 4)).toBeNull();
  });

  it("leaves other XML files alone", () => {
    const v = open("<beans><select>not sql</select></beans>");
    vi.advanceTimersByTime(1000);
    expect(published.get(PATH) ?? []).toEqual([]);
    expect(v.dom.querySelectorAll("[class*=ͼ]").length).toBe(0);
  });
});
