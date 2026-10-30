import { describe, expect, it } from "vitest";
import { useCustomScopes } from "@/platform/search";
import {
  FILE_SET_SCOPES,
  buildQuery,
  customScopeValue,
  describeQuery,
  findHistory,
  rememberFindString,
  resolveFindScope,
  useFindPopup,
  type NamedScope,
} from "../find/store";
import { scopesProblem } from "../find/ScopesDialog";
import { selectRow, selectedRows, type RowSelection } from "../find/rowSelection";

describe("Find in Files named scopes", () => {
  it("defaults to IDEA's Project Files and maps root-based scopes to backend file sets", () => {
    expect(useFindPopup.getState().namedScope).toBe("projectFiles");
    expect(FILE_SET_SCOPES).toEqual({ projectFiles: "all", productionFiles: "production", testFiles: "test" });
    const q = buildQuery(useFindPopup.getState(), { kind: "fileSet", set: "test" }, 0);
    expect(q.scope).toEqual({ kind: "fileSet", set: "test" });
    expect(describeQuery({ ...q, pattern: "x" }, "/p")).toBe("'x' in Project Test Files");
    expect(describeQuery({ ...q, pattern: "x", scope: { kind: "fileSet", set: "production" } }, "/p")).toBe(
      "'x' in Project Production Files",
    );
  });
});

describe("Find in Files module and custom scopes", () => {
  const inputs = { root: "/p", openPaths: () => ["/p/a.ts"], recentPaths: null };
  const base = useFindPopup.getState();

  it("a module searches its folder, the root module the project", () => {
    expect(resolveFindScope({ ...base, scopeTab: "module", module: "/member" }, inputs)).toEqual({
      kind: "directory",
      path: "/member",
    });
    expect(resolveFindScope({ ...base, scopeTab: "module", module: "web" }, inputs)).toEqual({
      kind: "directory",
      path: "/p/web",
    });
    expect(resolveFindScope({ ...base, scopeTab: "module", module: "" }, inputs)).toEqual({ kind: "project" });
  });

  it("named scopes resolve to file sets, files and custom patterns", () => {
    useCustomScopes.setState({ root: null, scopes: [{ name: "No tests", pattern: "!file:*test*" }] });
    const scope = (namedScope: NamedScope) => resolveFindScope({ ...base, scopeTab: "scope", namedScope }, inputs);
    expect(scope("productionFiles")).toEqual({ kind: "fileSet", set: "production" });
    expect(scope("openFiles")).toEqual({ kind: "files", paths: ["/p/a.ts"] });
    expect(scope(customScopeValue("No tests"))).toEqual({ kind: "pattern", pattern: "!file:*test*" });
    expect(scope(customScopeValue("gone"))).toEqual({ kind: "project" });
    const q = buildQuery({ ...base, pattern: "x" }, scope(customScopeValue("No tests")), 0);
    expect(describeQuery(q, "/p")).toBe("'x' in Scope 'No tests'");
    useCustomScopes.setState({ root: null, scopes: [] });
  });

  it("the scope editor needs unique names and a pattern", () => {
    expect(scopesProblem([{ name: "a", pattern: "*.ts" }])).toBeNull();
    expect(scopesProblem([{ name: " ", pattern: "*.ts" }])).toBe("Every scope needs a name");
    expect(
      scopesProblem([
        { name: "a", pattern: "*.ts" },
        { name: "a ", pattern: "*.rs" },
      ]),
    ).toBe("Duplicate scope name 'a'");
    expect(scopesProblem([{ name: "a", pattern: "" }])).toBe("Scope 'a' has no pattern");
  });
});

describe("Find in Files search context and history", () => {
  it("sends the context filter only when it narrows the search", () => {
    const base = useFindPopup.getState();
    expect(buildQuery(base, { kind: "project" }, 0)).not.toHaveProperty("context");
    const q = buildQuery({ ...base, pattern: "x", context: "exceptComments" }, { kind: "project" }, 0);
    expect(q.context).toBe("exceptComments");
    expect(describeQuery(q, "/p")).toBe("'x' in Project, except comments");
  });

  it("remembers recent strings per field, newest first and unique", () => {
    localStorage.clear();
    rememberFindString("find", "a");
    rememberFindString("find", "b");
    rememberFindString("find", "a");
    rememberFindString("replace", "r");
    rememberFindString("find", "  ");
    expect(findHistory("find")).toEqual(["a", "b"]);
    expect(findHistory("replace")).toEqual(["r"]);
  });
});

describe("results selection", () => {
  const rows = ["a", "b", "c", "d"].map((key) => ({ key }));
  const keys = (sel: RowSelection) => selectedRows(rows, sel).map((r) => r.key);

  it("⇧ extends from the anchor, ⌘ toggles, a plain click selects one", () => {
    let sel = selectRow(rows, { lead: 0, anchor: 0, keys: null }, 1);
    sel = selectRow(rows, sel, 3, "range");
    expect(keys(sel)).toEqual(["b", "c", "d"]);
    sel = selectRow(rows, sel, 0, "range");
    expect(keys(sel)).toEqual(["a", "b"]);
    sel = selectRow(rows, sel, 3, "toggle");
    expect(keys(sel)).toEqual(["a", "b", "d"]);
    sel = selectRow(rows, sel, 3, "toggle");
    expect(keys(sel)).toEqual(["a", "b"]);
    expect(sel.lead).toBe(1);
    sel = selectRow(rows, sel, 2);
    expect(keys(sel)).toEqual(["c"]);
  });
});
