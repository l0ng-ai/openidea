import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, render, within } from "@testing-library/react";
import { useProject } from "@/platform/project";
import { occurrenceNavigator } from "@/workbench/contributions";
import { ConsoleModel } from "./console";
import { ConsoleView, fileLinks, stepFileLink, type FileLink } from "./ConsoleView";

const nav = vi.hoisted(() => ({ openTarget: vi.fn(async () => {}) }));
vi.mock("./navigate", async (orig) => ({ ...(await orig<object>()), openTarget: nav.openTarget }));

const scrolled = vi.hoisted(() => [] as number[]);
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 20, key: index })),
    scrollToIndex: (index: number) => scrolled.push(index),
    measureElement: () => {},
    measure: () => {},
  }),
}));

const PANIC = [
  "panic: boom",
  "",
  "goroutine 1 [running]:",
  "main.parse(...)",
  "\t/home/me/app/parse.go:12 +0x1d",
  "main.main()",
  "\t/home/me/app/main.go:7 +0x25",
  "see https://go.dev/doc for help",
  "exit status 2",
];

function model(text: string, kind: "stdout" | "stderr" | "system" = "stderr") {
  const m = new ConsoleModel();
  m.append({ kind, text });
  m.flush();
  return m;
}

beforeEach(() => {
  nav.openTarget.mockClear();
  scrolled.length = 0;
  useProject.setState({ settings: null });
});

afterEach(cleanup);

describe("fileLinks", () => {
  const lines = model(PANIC.join("\n") + "\n").lines;

  it("lists the file links in output order, without URLs", () => {
    expect(fileLinks(lines, () => true).map((l) => [l.line, l.lineId, l.link.target.path, l.link.target.line])).toEqual(
      [
        [4, lines[4]!.id, "/home/me/app/parse.go", 12],
        [6, lines[6]!.id, "/home/me/app/main.go", 7],
      ],
    );
  });

  it("skips lines that are not shown and the IDE's own lines", () => {
    expect(fileLinks(lines, (i) => i !== 4).map((l) => l.line)).toEqual([6]);
    expect(fileLinks(model("/home/me/app/main.go:7\n", "system").lines, () => true)).toEqual([]);
  });

  it("has nothing without file links", () => {
    expect(fileLinks(model("all good\nhttps://example.com\n").lines, () => true)).toEqual([]);
    expect(fileLinks([], () => true)).toEqual([]);
  });

  it("lists several links on one line in order", () => {
    expect(fileLinks(model("a.go:1:2: x; see b.go:3:4\n").lines, () => true).map((l) => l.link.target.path)).toEqual([
      "a.go",
      "b.go",
    ]);
  });
});

describe("stepFileLink", () => {
  // Line ids 10, 12 and 20; two links on line 12.
  const links = [
    { lineId: 10, start: 4 },
    { lineId: 12, start: 0 },
    { lineId: 12, start: 30 },
    { lineId: 20, start: 2 },
  ] as FileLink[];
  const at = (i: number) => ({ lineId: links[i]!.lineId, start: links[i]!.start });

  it("starts at the first link going down and the last going up", () => {
    expect(stepFileLink(links, null, 1)).toBe(0);
    expect(stepFileLink(links, null, -1)).toBe(3);
  });

  it("steps from the current link, on the same line too, and stops at either end", () => {
    expect(stepFileLink(links, at(0), 1)).toBe(1);
    expect(stepFileLink(links, at(1), 1)).toBe(2);
    expect(stepFileLink(links, at(2), -1)).toBe(1);
    expect(stepFileLink(links, at(3), 1)).toBeNull();
    expect(stepFileLink(links, at(0), -1)).toBeNull();
  });

  it("keeps its place when the current link is no longer listed", () => {
    // Folded away (line 11, between two links).
    expect(stepFileLink(links, { lineId: 11, start: 0 }, 1)).toBe(1);
    expect(stepFileLink(links, { lineId: 11, start: 0 }, -1)).toBe(0);
    // Between the two links of line 12.
    expect(stepFileLink(links, { lineId: 12, start: 10 }, 1)).toBe(2);
    expect(stepFileLink(links, { lineId: 12, start: 10 }, -1)).toBe(1);
    // Trimmed off the top, or gone with Clear All: down starts at the first link, nothing above.
    expect(stepFileLink(links, { lineId: 1, start: 0 }, 1)).toBe(0);
    expect(stepFileLink(links, { lineId: 1, start: 0 }, -1)).toBeNull();
    // Folded away below the last link: nothing below, up starts at the last.
    expect(stepFileLink(links, { lineId: 99, start: 0 }, 1)).toBeNull();
    expect(stepFileLink(links, { lineId: 99, start: 0 }, -1)).toBe(3);
  });

  it("has nothing without links", () => {
    expect(stepFileLink([], null, 1)).toBeNull();
    expect(stepFileLink([], null, -1)).toBeNull();
    expect(stepFileLink([], { lineId: 1, start: 0 }, 1)).toBeNull();
  });
});

describe("Up / Down the Stack Trace in the console", () => {
  function setup(occurrences: string | undefined, text = PANIC.join("\n") + "\n") {
    const onFollowChange = vi.fn();
    const m = model(text);
    function Run() {
      const [follow, setFollow] = useState(true);
      return (
        <ConsoleView
          model={m}
          version={1}
          softWrap={false}
          follow={follow}
          onFollowChange={(v) => {
            onFollowChange(v);
            setFollow(v);
          }}
          cwd="/home/me/app"
          occurrences={occurrences}
        />
      );
    }
    const { container } = render(<Run />);
    return { log: within(container).getByRole("log"), onFollowChange };
  }

  it("opens the next / previous file link, selects it and stops following", () => {
    const { log, onFollowChange } = setup("run");
    let step: ReturnType<NonNullable<ReturnType<typeof occurrenceNavigator>>["go"]> = null;
    act(() => void (step = occurrenceNavigator("run")!.go(1, false)));
    expect(step).toEqual({ index: 1, total: 2 });
    expect(nav.openTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/home/me/app/parse.go", line: 12 }),
      "/home/me/app",
      false,
    );
    expect(onFollowChange).toHaveBeenCalledWith(false);
    expect(scrolled.at(-1)).toBe(4);
    const current = () => [...log.querySelectorAll("a")].filter((a) => a.className.includes("currentLink"));
    expect(current().map((a) => a.textContent)).toEqual(["/home/me/app/parse.go:12"]);

    act(() => void (step = occurrenceNavigator("run")!.go(1, true)));
    expect(step).toEqual({ index: 2, total: 2 });
    expect(nav.openTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/home/me/app/main.go", line: 7 }),
      "/home/me/app",
      true,
    );
    expect(current().map((a) => a.textContent)).toEqual(["/home/me/app/main.go:7"]);

    // At the bottom: nothing further down, and the selection stays.
    act(() => void (step = occurrenceNavigator("run")!.go(1, false)));
    expect(step).toBeNull();
    expect(nav.openTarget).toHaveBeenCalledTimes(2);
    expect(current().map((a) => a.textContent)).toEqual(["/home/me/app/main.go:7"]);

    act(() => void (step = occurrenceNavigator("run")!.go(-1, false)));
    expect(step).toEqual({ index: 1, total: 2 });
    expect(current().map((a) => a.textContent)).toEqual(["/home/me/app/parse.go:12"]);
  });

  it("skips links in collapsed folds", () => {
    useProject.setState({ settings: { console: { foldPatterns: ["parse.go"] } } as never });
    setup("run");
    let step: ReturnType<NonNullable<ReturnType<typeof occurrenceNavigator>>["go"]> = null;
    act(() => void (step = occurrenceNavigator("run")!.go(1, false)));
    expect(step).toEqual({ index: 1, total: 1 });
    expect(nav.openTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/home/me/app/main.go" }),
      "/home/me/app",
      false,
    );
  });

  it("finds links in output that arrived after the last step", () => {
    const m = model("\t/home/me/app/a.go:1\n");
    const view = (version: number) => (
      <ConsoleView
        model={m}
        version={version}
        softWrap={false}
        follow={false}
        onFollowChange={() => {}}
        cwd="/home/me/app"
        occurrences="run"
      />
    );
    const { rerender } = render(view(1));
    act(() => void occurrenceNavigator("run")!.go(1, false));
    expect(occurrenceNavigator("run")!.go(1, false)).toBeNull();
    m.append({ kind: "stderr", text: "\t/home/me/app/b.go:2\n" });
    m.flush();
    rerender(view(2));
    let step: ReturnType<NonNullable<ReturnType<typeof occurrenceNavigator>>["go"]> = null;
    act(() => void (step = occurrenceNavigator("run")!.go(1, false)));
    expect(step).toEqual({ index: 2, total: 2 });
    expect(nav.openTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/home/me/app/b.go" }),
      "/home/me/app",
      false,
    );
  });

  it("has no occurrences in output without file links", () => {
    setup("run", "hello\n");
    expect(occurrenceNavigator("run")!.go(1, false)).toBeNull();
    expect(nav.openTarget).not.toHaveBeenCalled();
  });

  it("registers no navigator without a tool window, and drops it on unmount", () => {
    setup(undefined);
    expect(occurrenceNavigator("run")).toBeNull();
    cleanup();
    setup("run");
    expect(occurrenceNavigator("run")).not.toBeNull();
    cleanup();
    expect(occurrenceNavigator("run")).toBeNull();
  });
});
