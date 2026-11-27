import { describe, expect, it } from "vitest";
import type { OutlineItem } from "@/platform/ipc";
import { pytestStubEdit, pythonTestSubjects, subjectsAtLine, type PythonTestSubject } from "./pythonTests";

const range = (from: number, to: number) => ({ start: { line: from, col: 0 }, end: { line: to, col: 0 } });
const item = (name: string, kind: OutlineItem["kind"], from: number, to: number, children: OutlineItem[] = []) =>
  ({ name, kind, detail: null, range: range(from, to), selection_range: range(from, from), children }) as OutlineItem;

const OUTLINE = [
  item("Priority", "class", 0, 3, [item("LOW", "field", 1, 1)]),
  item("TaskList", "class", 5, 20, [
    item("__init__", "method", 6, 7),
    item("add", "method", 9, 12),
    item("_index", "method", 14, 15),
    item("__len__", "method", 17, 18),
    item("pending", "method", 19, 20),
  ]),
  item("parse", "function", 22, 24),
  item("_helper", "function", 26, 27),
];

const apply = (text: string, edit: { changes: Array<{ from: number; to?: number; insert: string }> }) => {
  let out = text;
  for (const c of [...edit.changes].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to ?? c.from);
  return out;
};

const subjects = pythonTestSubjects(OUTLINE);
const pick = (...ids: string[]): PythonTestSubject[] => subjects.filter((s) => ids.includes(s.id));

describe("pythonTestSubjects", () => {
  it("lists public functions and methods, __init__ included, in source order", () => {
    expect(subjects.map((s) => s.id)).toEqual(["TaskList.__init__", "TaskList.add", "TaskList.pending", "parse"]);
  });

  it("preselects the function at the caret, else the class's methods", () => {
    expect(subjectsAtLine(subjects, 10).map((s) => s.id)).toEqual(["TaskList.add"]);
    expect(subjectsAtLine(subjects, 5).map((s) => s.id)).toEqual([
      "TaskList.__init__",
      "TaskList.add",
      "TaskList.pending",
    ]);
    expect(subjectsAtLine(subjects, 23).map((s) => s.id)).toEqual(["parse"]);
    expect(subjectsAtLine(subjects, 30)).toEqual([]);
  });
});

describe("pytestStubEdit", () => {
  it("writes a new file: the import, then functions, then a class per subject class", () => {
    const edit = pytestStubEdit("", "tasks.models", pick("parse", "TaskList.add", "TaskList.__init__"))!;
    const out = apply("", edit);
    expect(out).toBe(
      `from tasks.models import TaskList, parse


def test_parse():
    assert False


class TestTaskList:
    def test_init(self):
        assert False

    def test_add(self):
        assert False
`,
    );
    expect(out.slice(edit.caret).startsWith("assert False")).toBe(true);
    expect(out.slice(0, edit.caret)).toContain("def test_parse");
    expect(out.slice(0, edit.caret)).not.toContain("class TestTaskList");
  });

  it("adds only missing tests to an existing file and extends its import", () => {
    const text = `import pytest

from tasks.models import TaskList


class TestTaskList:
    def test_add(self):
        assert TaskList().add("x").title == "x"


def test_other():
    pass
`;
    const edit = pytestStubEdit(text, "tasks.models", pick("TaskList.add", "TaskList.pending", "parse"))!;
    const out = apply(text, edit);
    expect(out).toBe(`import pytest

from tasks.models import TaskList, parse


class TestTaskList:
    def test_add(self):
        assert TaskList().add("x").title == "x"

    def test_pending(self):
        assert False


def test_other():
    pass


def test_parse():
    assert False
`);
    // The first new test in the file: `test_pending`.
    expect(out.slice(0, edit.caret).endsWith("def test_pending(self):\n        ")).toBe(true);
  });

  it("adds an import after the existing ones when the module is not imported yet", () => {
    const text = `import os\n\n\ndef test_env():\n    assert os.sep\n`;
    const out = apply(text, pytestStubEdit(text, "tasks", pick("parse"))!);
    expect(out).toBe(
      `import os\nfrom tasks import parse\n\n\ndef test_env():\n    assert os.sep\n\n\ndef test_parse():\n    assert False\n`,
    );
  });

  it("keeps a class on the last line without a trailing newline apart from its new method", () => {
    const text = `from m import TaskList\n\n\nclass TestTaskList:\n    def test_add(self):\n        pass`;
    const out = apply(text, pytestStubEdit(text, "m", pick("TaskList.pending", "parse"), "  ")!);
    expect(out).toBe(
      `from m import TaskList, parse\n\n\nclass TestTaskList:\n    def test_add(self):\n        pass\n\n  def test_pending(self):\n    assert False\n\n\ndef test_parse():\n  assert False\n`,
    );
  });

  it("does not import a name the file already imports from elsewhere (a package re-export)", () => {
    const text = `from tasks import Priority, TaskList\n\n\ndef test_x():\n    pass\n`;
    const out = apply(text, pytestStubEdit(text, "tasks.models", pick("TaskList.add", "parse"))!);
    expect(out).toBe(
      `from tasks import Priority, TaskList\nfrom tasks.models import parse\n\n\ndef test_x():\n    pass\n\n\ndef test_parse():\n    assert False\n\n\nclass TestTaskList:\n    def test_add(self):\n        assert False\n`,
    );
  });

  it("reads a parenthesized import over several lines and adds a new one after it", () => {
    const text = `import os\nfrom tasks.models import (\n    TaskList,  # the list\n)\n\n\ndef test_env():\n    assert os.sep\n`;
    const out = apply(text, pytestStubEdit(text, "tasks.models", pick("TaskList.add", "parse"))!);
    expect(
      out.startsWith(
        `import os\nfrom tasks.models import (\n    TaskList,  # the list\n)\nfrom tasks.models import parse\n`,
      ),
    ).toBe(true);
    expect(out).not.toContain("import TaskList");
  });

  it("reads a backslash-continued import", () => {
    const text = `from tasks.models import Priority, \\\n    TaskList\n\n\ndef test_x():\n    pass\n`;
    const out = apply(text, pytestStubEdit(text, "tasks.models", pick("TaskList.add"))!);
    expect(out.split("\n").slice(0, 3)).toEqual(["from tasks.models import Priority, \\", "    TaskList", ""]);
    expect(out).toContain("class TestTaskList:");
  });

  it("is null when every chosen test exists", () => {
    const text = `from m import parse\n\n\ndef test_parse():\n    pass\n`;
    expect(pytestStubEdit(text, "m", pick("parse"))).toBeNull();
  });
});
