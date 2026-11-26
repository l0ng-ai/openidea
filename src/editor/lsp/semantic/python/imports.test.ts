import { describe, expect, it } from "vitest";
import { importLine, importedFrom, neededImports, placeImports, topLevelBindings } from "./imports";

const models = `from __future__ import annotations

import os
from datetime import date
from enum import IntEnum
from .util import (
    slug,
    clean as tidy,
)

Alias = dict[str, int]


class Priority(IntEnum):
    LOW = 1


class TaskList:
    def add(self, title: str, priority: Priority = Priority.NORMAL, due: date | None = None) -> Task:
        pass
`.split("\n");

describe("override imports", () => {
  it("reads the top-level bindings of a module", () => {
    const b = topLevelBindings(models);
    expect(b.get("date")).toEqual({ import: "from datetime import date" });
    expect(b.get("os")).toEqual({ import: "import os" });
    expect(b.get("tidy")).toEqual({ import: "from .util import clean as tidy" });
    expect(b.get("slug")).toEqual({ import: "from .util import slug" });
    expect(b.get("Priority")).toEqual({ defined: true });
    expect(b.get("Alias")).toEqual({ defined: true });
    expect(b.has("add")).toBe(false);
  });

  it("finds where a base class is imported from", () => {
    const current = [
      "from tasks.models import TaskList",
      "import abc",
      "from tasks import models",
      "import numpy as np",
    ];
    expect(importedFrom(current, "TaskList")).toBe("tasks.models");
    expect(importedFrom(current, "abc.ABC")).toBe("abc");
    expect(importedFrom(current, "models.Base")).toBe("tasks.models");
    expect(importedFrom(current, "np.ndarray")).toBe("numpy");
    expect(importedFrom(current, "Local")).toBeNull();
  });

  it("imports the names a copied signature needs, as the base module binds them", () => {
    const sig = ["str", "Priority", "NORMAL", "date", "None", "Task"];
    const current = topLevelBindings(["from tasks.models import TaskList", "from datetime import date"]);
    expect(neededImports(sig, current, topLevelBindings(models), "tasks.models")).toEqual([
      "from tasks.models import Priority",
    ]);
    expect(neededImports(["slug", "None"], current, topLevelBindings(models), "tasks.models")).toEqual([]);
    expect(neededImports(["slug", "None"], current, topLevelBindings(models), "")).toEqual(["from .util import slug"]);
    expect(neededImports(sig, new Map(), topLevelBindings(models), null)).toEqual(["from datetime import date"]);
  });

  it("puts new imports after the last import, else after the module docstring", () => {
    expect(importLine(models)).toBe(9);
    expect(importLine(["from x import a, \\", "    b", "", "y = 1"])).toBe(2);
    expect(topLevelBindings(["from x import a, \\", "    b"]).get("b")).toEqual({ import: "from x import b" });
    expect(importLine(['"""Doc', 'string."""', "# note", "", "class A:", "    pass"])).toBe(4);
    expect(importLine(['"""Doc."""', "x = 1"])).toBe(1);
    expect(importLine(["class A:", "    pass"])).toBe(0);
  });

  it("adds names to an existing one-line import of the module, else one new line per module", () => {
    const lines = ["from tasks.models import TaskList", "from x import (a,", "  b)"];
    expect(
      placeImports(lines, [
        "from tasks.models import Priority",
        "from datetime import date",
        "from tasks.models import Task",
        "from x import c",
        "import os",
        "from datetime import time",
      ]),
    ).toEqual({
      appended: new Map([[0, ", Priority, Task"]]),
      added: ["import os", "from datetime import date, time", "from x import c"],
    });
  });
});
