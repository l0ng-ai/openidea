import { describe, expect, it } from "vitest";
import type { AgentConfigOption, AgentEntry, AgentStatus, AgentTask } from "@/bindings";
import {
  applyCompletion,
  atEdgeLine,
  canSend,
  completionAt,
  imageFromDataUrl,
  mainOptions,
  matchCommands,
  mentionOf,
  modeIcon,
  nextValue,
  recall,
  toPrompt,
  retryParts,
  usageLabel,
  workTime,
} from "./composerModel";
import {
  age,
  attentionChange,
  branchLabel,
  entriesKey,
  findSubagent,
  groupTasks,
  subagentTitle,
  turnNumbers,
  upsertEntry,
  type SubagentEntry,
} from "./model";
import { markdownHtml } from "./Markdown";

function task(id: string, status: AgentStatus, updatedMs: number): AgentTask {
  return {
    id,
    title: id,
    provider: "claude",
    model: null,
    status,
    isolation: "worktree",
    cwd: "/w",
    branch: `agent/${id}`,
    base: "main",
    baseCommit: "abc",
    error: null,
    createdMs: 0,
    updatedMs,
    config: [],
    commands: [],
    usage: null,
    queue: [],
  };
}

const option = (category: string, values: string[], current: string | null): AgentConfigOption => ({
  id: category,
  name: category,
  description: null,
  category,
  current,
  values: values.map((value) => ({ value, name: value, description: null })),
  via: "option",
});

describe("agent composer", () => {
  it("completes @files anywhere and /commands as the first word", () => {
    expect(completionAt("fix @src/le", 11)).toEqual({ kind: "file", query: "src/le", from: 4, to: 11 });
    expect(completionAt("/rev", 4)).toEqual({ kind: "command", query: "rev", from: 0, to: 4 });
    expect(completionAt("run /rev", 8)).toBeNull();
    expect(completionAt("a@b", 3)).toBeNull();
    const c = completionAt("see @le and", 7)!;
    expect(applyCompletion("see @le and", c, "@src/lexer.rs")).toEqual({ text: "see @src/lexer.rs and", caret: 18 });
    const cmds = [
      { name: "init", description: "", hint: null },
      { name: "review", description: "", hint: null },
      { name: "pr-review", description: "", hint: null },
    ];
    expect(matchCommands(cmds, "rev").map((c) => c.name)).toEqual(["review", "pr-review"]);
  });

  it("matches commands by prefix, plugin name, substring, then letters in order", () => {
    const cmds = ["triage", "verify", "issue-fix", "brooks-lint:brooks-review", "pr-review", "init"].map((name) => ({
      name,
      description: "",
      hint: null,
    }));
    const names = (q: string) => matchCommands(cmds, q).map((c) => c.name);
    expect(names("trig")).toEqual(["triage"]);
    expect(names("brooks-r")).toEqual(["brooks-lint:brooks-review"]);
    expect(names("rev")).toEqual(["brooks-lint:brooks-review", "pr-review"]);
    expect(names("if")).toEqual(["verify", "issue-fix"]);
    expect(names("xyz")).toEqual([]);
    expect(names("")).toHaveLength(cmds.length);
  });

  it("sends only the files still mentioned", () => {
    const prompt = toPrompt({
      text: " look at @src/a.rs:3-5 and @b.rs ",
      files: [
        { path: "/w/src/a.rs", rel: "src/a.rs" },
        { path: "/w/b.rs", rel: "b.rs" },
        { path: "/w/b.rs", rel: "b.rs" },
        { path: "/w/gone.rs", rel: "gone.rs" },
      ],
      images: [],
    });
    expect(prompt).toEqual({ text: "look at @src/a.rs:3-5 and @b.rs", files: ["/w/src/a.rs", "/w/b.rs"], images: [] });
    expect(mentionOf("a.rs", { from: 3, to: 3 })).toBe("@a.rs:3");
    expect(canSend({ text: " ", files: [], images: [] })).toBe(false);
  });

  it("recalls history from the edge lines only", () => {
    const h = ["newest", "older"];
    expect(recall(h, -1, -1)).toBe(0);
    expect(recall(h, 0, -1)).toBe(1);
    expect(recall(h, 1, -1)).toBeNull();
    expect(recall(h, 0, 1)).toBe(-1);
    expect(recall(h, -1, 1)).toBeNull();
    expect(atEdgeLine("a\nb", 1, -1)).toBe(true);
    expect(atEdgeLine("a\nb", 3, -1)).toBe(false);
    expect(atEdgeLine("a\nb", 1, 1)).toBe(false);
  });

  it("picks the main settings and cycles the mode", () => {
    const config = [option("fast", ["on"], null), option("mode", ["ask", "code"], "code"), option("model", ["m"], "m")];
    expect(mainOptions(config).map((o) => o.id)).toEqual(["model", "mode"]);
    expect(nextValue(config[1]!)).toBe("ask");
    expect(
      ["default", "acceptEdits", "plan", "auto", "bypassPermissions", "auto_edit", "read-only", "x"].map(modeIcon),
    ).toEqual(["lock", "edit", "todo", "run", "unlock", "edit", "eye", "lock"]);
    expect(usageLabel({ used: 24_000, size: 200_000 })).toEqual({
      short: "12%",
      detail: "24k / 200k tokens",
    });
    expect(imageFromDataUrl("data:image/png;base64,AAA", "a.png")).toEqual({
      mimeType: "image/png",
      data: "AAA",
      name: "a.png",
    });
    expect(imageFromDataUrl("data:text/plain;base64,AAA")).toBeNull();
  });
});

describe("usage meters", () => {
  it("formats token counts", () => {
    expect(usageLabel({ used: 83_100, size: 1_000_000 }).detail).toBe("83.1k / 1M tokens");
  });

  it("adds up the time spent on turns", () => {
    const user = (sentMs: number, doneMs: number | null): AgentEntry => ({
      type: "user",
      text: "",
      attachments: [],
      sentMs,
      doneMs,
    });
    const entries = [user(0, 5_000), { type: "agent", text: "" } as AgentEntry, user(10_000, null)];
    expect(workTime(entries, 12_000)).toBe(7_000);
    expect(workTime(entries, null)).toBe(5_000);
  });
});

describe("agents model", () => {
  it("groups tasks by what they need, newest first", () => {
    const groups = groupTasks([
      task("a", "ready", 1),
      task("b", "needsInput", 2),
      task("c", "running", 3),
      task("d", "starting", 4),
      task("e", "ready", 5),
    ]);
    expect(groups.map((g) => [g.status, g.tasks.map((t) => t.id)])).toEqual([
      ["needsInput", ["b"]],
      ["running", ["d", "c"]],
      ["ready", ["e", "a"]],
    ]);
  });

  it("upserts entries in place and refuses gaps", () => {
    const a: AgentEntry = { type: "agent", text: "a" };
    const b: AgentEntry = { type: "agent", text: "b" };
    expect(upsertEntry([a], 0, b)).toEqual([b]);
    expect(upsertEntry([a], 1, b)).toEqual([a, b]);
    expect(upsertEntry([a], 3, b)).toBeNull();
  });

  it("notifies on finish, failure and questions only", () => {
    expect(attentionChange("running", "ready")).toBe("finished");
    expect(attentionChange("running", "failed")).toBe("failed");
    expect(attentionChange("running", "limited")).toBe("failed");
    expect(attentionChange("running", "needsInput")).toBe("input");
    expect(attentionChange("needsInput", "running")).toBeNull();
    expect(attentionChange("ready", "archived")).toBeNull();
    expect(attentionChange(undefined, "ready")).toBeNull();
  });

  it("finds subagent cards and keys their conversations apart", () => {
    const card: SubagentEntry = {
      type: "subagent",
      id: "c1",
      title: null,
      description: "Find the lexer",
      status: "running",
      error: null,
      prompt: null,
      reply: null,
      tools: 0,
      activity: null,
      startedMs: 0,
      endedMs: null,
      cancellable: false,
    };
    expect(findSubagent([{ type: "agent", text: "a" }, card], "c1")).toBe(card);
    expect(findSubagent(undefined, "c1")).toBeUndefined();
    expect(subagentTitle(card)).toBe("Find the lexer");
    expect(subagentTitle({ ...card, title: "Explore" })).toBe("Explore");
    expect(entriesKey("t", null)).toBe("t");
    expect(entriesKey("t", "c1")).not.toBe(entriesKey("t", null));
  });

  it("formats labels", () => {
    expect(branchLabel("agent/fix-lexer")).toBe("fix-lexer");
    expect(branchLabel(null)).toBe("");
    expect(age(0, 30_000)).toBe("now");
    expect(age(0, 5 * 60_000)).toBe("5m");
    expect(age(0, 3 * 3_600_000)).toBe("3h");
  });

  it("renders agent markdown without scripts", () => {
    const html = markdownHtml("**bold** <img src=x onerror=alert(1)><script>alert(1)</script>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
  });

  it("gives the text of a list item with a nested list its own block", () => {
    const html = markdownHtml("- **parent** text:\n  - child\n- plain");
    expect(html).toContain("<li><div><strong>parent</strong> text:</div><ul>");
    expect(html).toContain("<li>child</li>");
    expect(html).toContain("<li>plain</li>");
  });
});

describe("turns", () => {
  it("numbers the messages that start a turn, not those steered into one", () => {
    const user = (text: string, steered = false): AgentEntry => ({
      type: "user",
      text,
      attachments: [],
      sentMs: null,
      doneMs: null,
      steered,
    });
    const entries: AgentEntry[] = [
      user("first"),
      { type: "agent", text: "ok" },
      user("also", true),
      user("second"),
      { type: "agent", text: "done" },
    ];
    expect([...turnNumbers(entries)]).toEqual([
      [0, 0],
      [3, 1],
    ]);
  });
});

describe("retryParts", () => {
  it("counts down to the next attempt and shows the limit when known", () => {
    const retry = { attempt: 3, maxRetries: 10, retryAtMs: 5_400, error: "Connection error." };
    expect(retryParts(retry, 1_000)).toEqual({ attempt: "3/10", wait: 5 });
    expect(retryParts({ ...retry, maxRetries: null }, 9_000)).toEqual({ attempt: "3", wait: 0 });
  });
});
