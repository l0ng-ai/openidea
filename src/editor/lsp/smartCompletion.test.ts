import { describe, expect, it } from "vitest";
import type { CompletionItem } from "@/platform/ipc";
import {
  expectedFromSignature,
  expectedFromText,
  itemType,
  mentionedNames,
  smartItems,
  typeFits,
  typeParts,
} from "./smartCompletion";

const item = (label: string, kind: CompletionItem["kind"], doc?: string): CompletionItem =>
  ({
    label,
    kind,
    detail: null,
    documentation: doc ? { kind: "markdown", value: "```python\n" + doc + "\n```" } : null,
  }) as CompletionItem;

describe("types", () => {
  it("splits unions and drops module prefixes", () => {
    expect(typeParts("Optional[models.Task]")).toEqual(["Task", "None"]);
    expect(typeParts("int | None")).toEqual(["int", "None"]);
    expect(typeParts("Union[int, dict[str, int]]")).toEqual(["int", "dict[str, int]"]);
    expect(typeParts("typing.List[a.b.Task]")).toEqual(["list[Task]"]);
  });

  it("fits when every member is expected", () => {
    expect(typeFits("date", typeParts("date | None"))).toBe(true);
    expect(typeFits("date | None", typeParts("date"))).toBe(false);
    expect(typeFits("list[Task]", typeParts("list[Task]"))).toBe(true);
    expect(typeFits("list[int]", typeParts("list[Task]"))).toBe(false);
  });
});

describe("expected type", () => {
  it("reads the active parameter's annotation", () => {
    const label = "(p: Priority, d: date = ...) -> Task";
    const help = (active: number) => ({
      signatures: [
        {
          label,
          documentation: null,
          parameters: [
            [1, 12],
            [14, 27],
          ] as [number, number][],
        },
      ],
      activeSignature: 0,
      activeParameter: active,
    });
    expect(expectedFromSignature(help(0))).toBe("Priority");
    expect(expectedFromSignature(help(1))).toBe("date");
    expect(expectedFromSignature(null)).toBeNull();
  });

  it("reads annotated assignments and return annotations", () => {
    expect(expectedFromText([], 0, "due: date | None = ")).toBe("date | None");
    const lines = ["class A:", "    def f(", "        self,", "    ) -> list[Task]:", "        x = 1"];
    expect(expectedFromText(lines, 5, "        return ")).toBe("list[Task]");
    expect(expectedFromText(["async def g() -> int:"], 1, "    return ")).toBeNull();
    expect(expectedFromText(["def h():"], 1, "    return ")).toBeNull();
    expect(expectedFromText([], 0, "take(")).toBeNull();
  });
});

describe("smartItems", () => {
  it("keeps variables, calls and classes of the expected type", async () => {
    const items = [
      item("today", "variable", "today: date"),
      item("count", "variable", "count: int"),
      item("make", "function", "def make(\n    n: int\n) -> date"),
      item("later", "function", "async def later() -> date"),
      item("date", "class"),
      item("d=", "variable"),
      item("None", "keyword"),
      item("True", "keyword"),
    ];
    const mentioned = mentionedNames("today = make(1) + later() + date(1, 2, 3)");
    const kept = await smartItems(
      [...items, item("today_utc", "variable", "today_utc: date")],
      "date | None",
      async (i) => i,
      mentioned,
    );
    expect(kept.map((i) => [i.label, i.labelDescription])).toEqual([
      ["today", "date"],
      ["make", "date"],
      ["date", "date"],
      ["None", undefined],
    ]);
    expect((await smartItems(items, "bool", async (i) => i, mentioned)).map((i) => i.label)).toEqual(["True"]);
  });

  it("reads a type from the documentation", () => {
    expect(
      itemType(item("tl", "variable"), { kind: "markdown", value: "```python\n(variable) tl: TaskList\n```" }),
    ).toBe("TaskList");
  });
});
