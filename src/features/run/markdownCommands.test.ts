import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { iconAreaExtension } from "@/editor/core/cm/iconArea";
import * as actions from "@/platform/actions";
import { useProject } from "@/platform/project";
import * as ui from "@/ui";
import {
  commandMenuItems,
  markdownCommandGutter,
  markdownCommands,
  trimPrompt,
  type CommandEntry,
} from "./markdownCommands";

const accepts = (line: string) => /^(mvn|\.\/gradlew) /.test(line);

describe("Markdown commands", () => {
  it("runs shell blocks from their fence and recognized command lines from any block", () => {
    const text = [
      "## Setup",
      "```shell",
      "$ mise install   # tools",
      "",
      "mvn test",
      "```",
      "```java",
      "mvn not a command here? still a recognized line",
      "```",
      "~~~text",
      "./gradlew build",
      "~~~",
    ].join("\n");
    expect(markdownCommands(text, accepts).map((e) => [e.kind, e.line, e.lines])).toEqual([
      ["block", 1, ["mise install", "mvn test"]],
      ["line", 4, ["mvn test"]],
      ["line", 7, ["mvn not a command here? still a recognized line"]],
      ["line", 10, ["./gradlew build"]],
    ]);
  });

  it("ignores blocks without commands, other languages and unclosed fences' closing rules", () => {
    expect(markdownCommands("```bash\n# only a comment\n```", accepts)).toEqual([]);
    expect(markdownCommands("```python\nprint(1)\n```", accepts)).toEqual([]);
    // A shorter closing fence doesn't close a longer one.
    expect(markdownCommands("````sh\nls\n```\npwd\n````", accepts)[0]?.lines).toEqual(["ls", "```", "pwd"]);
  });

  it("keeps quoted # and PowerShell lines as written", () => {
    expect(trimPrompt(['echo "a # b" # note', "$ git log #x", "#!/bin/sh"])).toEqual(['echo "a # b"', "git log"]);
    expect(markdownCommands("```powershell\n$env:X = 1 # keep\n```", accepts)[0]?.lines).toEqual(["$env:X = 1 # keep"]);
  });
});

describe("Markdown command menu", () => {
  const block: CommandEntry = { kind: "block", name: "block:1", line: 1, lines: ["make build"] };
  afterEach(() => useProject.setState({ project: null, settings: null }));
  const open = (commandDirectory?: string) =>
    useProject.setState({
      project: { root: "/p", name: "p", settings: {}, trusted: true, isGit: false },
      settings: { languages: { markdown: { commandDirectory } } } as never,
    });

  it("asks for the folder when the project and the file's folder differ", async () => {
    open();
    expect((await commandMenuItems(block, "/p/docs/README.md")).map((i) => "label" in i && i.label)).toEqual([
      "Run from Project Root Directory",
      "Run from Parent Directory of Current File (docs)",
    ]);
    expect((await commandMenuItems(block, "/p/README.md")).map((i) => "label" in i && i.label)).toEqual([
      "Run in Terminal",
    ]);
  });

  it("uses the configured folder", async () => {
    open("file");
    expect((await commandMenuItems(block, "/p/docs/README.md")).map((i) => "label" in i && i.label)).toEqual([
      "Run in Terminal",
    ]);
  });
});

describe("Markdown command gutter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useProject.setState({ project: null, settings: null });
  });

  it("runs a block's current commands after it is edited", async () => {
    useProject.setState({
      project: { root: "/p", name: "p", settings: {}, trusted: true, isGit: false },
      settings: {} as never,
    });
    const show = vi.spyOn(ui, "showContextMenu").mockImplementation(() => {});
    const run = vi.spyOn(actions, "executeAction").mockResolvedValue(undefined as never);
    const view = new EditorView({
      doc: "```sh\nls\n```",
      parent: document.body,
      extensions: [
        iconAreaExtension,
        markdownCommandGutter({ doc: 1, path: "/p/README.md", language: "markdown", uiMode: null, readOnly: false }),
      ],
    });
    const button = () => view.dom.querySelector<HTMLButtonElement>('button[aria-label="Run in Terminal"]');
    try {
      await vi.waitFor(() => expect(button()).not.toBeNull());
      view.dispatch({ changes: { from: 6, to: 8, insert: "pwd" } });
      await new Promise((r) => setTimeout(r, 400));
      button()!.click();
      await vi.waitFor(() => expect(show).toHaveBeenCalled());
      const [item] = show.mock.calls[0]![1];
      (item as { run: () => void }).run();
      expect(run).toHaveBeenCalledWith("terminal.runLines", { lines: ["pwd"], cwd: "/p" });
    } finally {
      view.destroy();
    }
  });
});
