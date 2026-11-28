import { describe, expect, it } from "vitest";
import { mergeEdits, validFixtureName, where } from "./index";

describe("where", () => {
  it("shows installed fixtures below site-packages and the project's relative to it", () => {
    expect(where("/p/.venv/lib/python3.12/site-packages/_pytest/tmpdir.py", "/p")).toBe("_pytest/tmpdir.py");
    expect(where("/p/tests/conftest.py", "/p")).toBe("tests/conftest.py");
    expect(where("/elsewhere/conftest.py", "/p")).toBe("/elsewhere/conftest.py");
  });
});

describe("validFixtureName", () => {
  it("takes identifiers that are no keywords", () => {
    expect(["todo", "_db", "tasks2"].every(validFixtureName)).toBe(true);
    expect(["class", "None", "2x", "a-b", ""].some(validFixtureName)).toBe(false);
  });
});

describe("mergeEdits", () => {
  const range = (line: number, col: number) => ({ start: { line, col }, end: { line, col: col + 5 } });
  const edit = (path: string, ...ranges: Array<[number, number]>) =>
    ({ kind: "edit", path, edits: ranges.map(([l, c]) => ({ range: range(l, c), new_text: "todo" })) }) as const;

  it("adds the server's edits to the fixture's, one file edit per path, the definition once", () => {
    const own = { files: [edit("/p/conftest.py", [6, 4]), edit("/p/test_a.py", [12, 14])] };
    const server = { files: [edit("/p/conftest.py", [6, 4], [20, 8]), edit("/p/helpers.py", [0, 20])] };
    const merged = mergeEdits(own, server);
    expect(merged.files.map((f) => (f.kind === "edit" ? [f.path, f.edits.length] : null))).toEqual([
      ["/p/conftest.py", 2],
      ["/p/test_a.py", 1],
      ["/p/helpers.py", 1],
    ]);
  });
});
