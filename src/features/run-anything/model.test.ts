import { beforeEach, describe, expect, it } from "vitest";
import type { RunAnythingProvider } from "@/workbench/contributions";
import {
  buildRows,
  clearHistory,
  MAX_HISTORY,
  matches,
  pushHistory,
  readHistory,
  shellCommand,
  shellRunConfig,
} from "./model";

beforeEach(() => localStorage.clear());

describe("run anything", () => {
  it("keeps a per-project history, newest first and without duplicates", () => {
    pushHistory("/a", "ls");
    pushHistory("/a", "make test");
    pushHistory("/a", " ls ");
    pushHistory("/b", "npm run dev");
    expect(readHistory("/a")).toEqual(["ls", "make test"]);
    expect(readHistory("/b")).toEqual(["npm run dev"]);
    for (let i = 0; i < MAX_HISTORY + 5; i++) pushHistory("/a", `cmd ${i}`);
    expect(readHistory("/a")).toHaveLength(MAX_HISTORY);
    clearHistory("/a");
    expect(readHistory("/a")).toEqual([]);
  });

  it("matches every word of the query", () => {
    expect(matches("mvn clean install", "inst mvn")).toBe(true);
    expect(matches("mvn clean install", "gradle")).toBe(false);
    expect(matches("anything", "")).toBe(true);
  });

  it("lists recent commands, then each provider's group; a failing provider is skipped", () => {
    const ran: string[] = [];
    const providers: RunAnythingProvider[] = [
      {
        id: "npm",
        group: "npm scripts",
        items: (q) =>
          [{ key: "dev", label: "npm run dev", icon: "run", run: () => {} }].filter((i) => matches(i.label, q)),
      },
      {
        id: "broken",
        group: "Broken",
        items: () => {
          throw new Error("nope");
        },
      },
    ];
    const rows = buildRows("run", ["npm run dev", "ls"], providers, (l) => ran.push(l));
    expect(rows.map((r) => (r.kind === "section" ? `# ${r.label}` : r.item.label))).toEqual([
      "# Recent",
      "npm run dev",
      "# npm scripts",
      "npm run dev",
    ]);
    const recent = rows[1]!;
    if (recent.kind === "item") recent.item.run();
    expect(ran).toEqual(["npm run dev"]);
  });

  it("runs a plain line through the platform shell in the project directory", () => {
    expect(shellCommand("echo hi", false)).toEqual({ command: "/bin/sh", args: ["-c", "echo hi"] });
    expect(shellCommand("dir", true)).toEqual({ command: "cmd.exe", args: ["/d", "/s", "/c", "dir"] });
    const cfg = shellRunConfig("x".repeat(80), "/work", false);
    expect(cfg.kind).toBe("external");
    expect(cfg.cwd).toBe("/work");
    expect(cfg.name).toHaveLength(58);
  });
});

describe("provider command sections", () => {
  it("merges build-tool recents with shared history without duplicate commands", () => {
    const provider: RunAnythingProvider = {
      id: "build-tools",
      group: "Build Tools",
      items: () => [
        {
          key: "recent",
          label: "mvn clean",
          completion: "mvn clean ",
          group: { id: "recent", label: "Recent" },
          run: () => {},
        },
        { key: "goal", label: "mvn clean", group: { id: "maven", label: "Maven Goals" }, run: () => {} },
      ],
    };
    const rows = buildRows("mvn", ["mvn clean"], [provider], () => {});
    expect(rows.map((r) => (r.kind === "section" ? r.label : r.item.label))).toEqual([
      "Recent",
      "mvn clean",
      "Maven Goals",
      "mvn clean",
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it("limits each section separately so recent commands cannot hide available goals", () => {
    const provider: RunAnythingProvider = {
      id: "build-tools",
      group: "Build Tools",
      items: () => [
        ...Array.from({ length: 20 }, (_, i) => ({
          key: `recent-${i}`,
          label: `mvn command-${i}`,
          group: { id: "recent", label: "Recent" },
          run: () => {},
        })),
        { key: "compile", label: "mvn compile", group: { id: "maven", label: "Maven Goals" }, run: () => {} },
      ],
    };
    const rows = buildRows("mvn", [], [provider], () => {});
    expect(rows.filter((r) => r.kind === "item" && r.group === "recent")).toHaveLength(8);
    expect(rows.at(-1)).toMatchObject({ kind: "item", item: { label: "mvn compile" } });
  });

  it("keeps groups from different providers separate even when their local ids match", () => {
    const providers: RunAnythingProvider[] = ["maven", "gradle"].map((id) => ({
      id,
      group: id,
      items: () => [{ key: "build", label: `${id} build`, group: { id: "commands", label: id }, run: () => {} }],
    }));
    const rows = buildRows("", [], providers, () => {});
    expect(rows.filter((r) => r.kind === "section").map((r) => r.key)).toEqual([
      "s:maven:commands",
      "s:gradle:commands",
    ]);
  });
});
