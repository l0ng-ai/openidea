// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRunAnythingProvider } from "@/workbench/contributions";
import { recognised, runRecognised, typedCommand, type PromptEnd } from "./smartCommands";

vi.mock("@/platform/workflowSettings", () => ({
  workflowSettings: () => ({ terminal: { runCommandsUsingIde: true } }),
}));

const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));

const terms: Terminal[] = [];
afterEach(() => terms.splice(0).forEach((t) => t.dispose()));

/** A terminal showing `$ ` with the prompt's end marked, as OSC 133 B does. */
async function prompted(cols = 40): Promise<{ term: Terminal; prompt: PromptEnd }> {
  const term = new Terminal({ allowProposedApi: true, cols, rows: 6 });
  terms.push(term);
  await write(term, "out\r\n$ ");
  return {
    term,
    prompt: { marker: term.registerMarker(0)!, x: term.buffer.active.cursorX },
  };
}

describe("typedCommand", () => {
  it("reads what follows the prompt", async () => {
    const { term, prompt } = await prompted();
    expect(typedCommand(term, prompt)).toBeNull();
    await write(term, "  pytest -k a  ");
    expect(typedCommand(term, prompt)).toEqual({
      text: "pytest -k a",
      rows: [{ y: 1, start: 4, end: 15 }],
    });
  });

  it("follows wrapped rows", async () => {
    const { term, prompt } = await prompted(10);
    await write(term, "npm run build");
    expect(typedCommand(term, prompt)).toEqual({
      text: "npm run build",
      rows: [
        { y: 1, start: 2, end: 10 },
        { y: 2, start: 0, end: 5 },
      ],
    });
  });

  it("leaves out an autosuggestion after the cursor", async () => {
    const { term, prompt } = await prompted();
    await write(term, "pyt\x1b[90mest -x\x1b[0m\x1b[6D");
    expect(typedCommand(term, prompt)?.text).toBe("pyt");
    // Text the user moved back over is still the command.
    await write(term, "\x1b[K\x1b[0mest -x\x1b[3D");
    expect(typedCommand(term, prompt)?.text).toBe("pytest -x");
  });

  it("leaves out a right prompt", async () => {
    const { term, prompt } = await prompted(30);
    // zsh draws RPROMPT at the right edge, then moves the cursor back after the typed text.
    await write(term, "pytest -q\x1b[s\x1b[1;24H\x1b[2;24H12:00 ─╯\x1b[u");
    expect(typedCommand(term, prompt)).toEqual({ text: "pytest -q", rows: [{ y: 1, start: 2, end: 11 }] });
    await write(term, "  -x");
    expect(typedCommand(term, prompt)?.text).toBe("pytest -q  -x");
  });

  it("is off in the alternate buffer", async () => {
    const { term, prompt } = await prompted();
    await write(term, "pytest\x1b[?1049h");
    expect(typedCommand(term, prompt)).toBeNull();
  });
});

describe("recognised commands", () => {
  it("asks Run Anything providers, leaving shell syntax to the shell", async () => {
    const execute = vi.fn(() => true);
    const dispose = registerRunAnythingProvider({
      id: "test",
      group: "Test",
      items: () => [],
      accepts: (line, cwd) => line.startsWith("pytest") && cwd === "/p",
      execute,
    });
    try {
      expect(recognised("pytest -x", "/p")).toBe(true);
      expect(recognised("pytest -x", "/q")).toBe(false);
      expect(recognised("pytest -x && ls", "/p")).toBe(false);
      expect(await runRecognised("pytest -x", "/p")).toBe(true);
      expect(execute).toHaveBeenCalledWith("pytest -x", "/p");
      expect(await runRecognised("ls", "/p")).toBe(false);
    } finally {
      dispose();
    }
  });
});
