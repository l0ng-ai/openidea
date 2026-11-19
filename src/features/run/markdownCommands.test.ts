import { afterEach, describe, expect, it } from "vitest";
import { useProject } from "@/platform/project";
import { commandMenuItems, markdownCommands, trimPrompt, type CommandEntry } from "./markdownCommands";

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
