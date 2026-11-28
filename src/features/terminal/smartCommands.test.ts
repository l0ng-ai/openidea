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

  it.each([
    ["dim", "\x1b[2m"],
    ["bright black", "\x1b[90m"],
    ["palette grey (fg=244)", "\x1b[38;5;244m"],
    ["RGB grey (#666)", "\x1b[38;2;102;102;102m"],
  ])("leaves out a %s autosuggestion", async (_, style) => {
    const { term, prompt } = await prompted();
    await write(term, `pyt${style}est -x\x1b[0m\x1b[6D`);
    expect(typedCommand(term, prompt)?.text).toBe("pyt");
  });

  it("keeps coloured text after the cursor (syntax highlighting)", async () => {
    const { term, prompt } = await prompted();
    await write(term, "pytest \x1b[32m-x\x1b[0m\x1b[3D");
    expect(typedCommand(term, prompt)?.text).toBe("pytest -x");
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
      accepts: (line, terminal) => line.startsWith("pytest") && terminal?.cwd === "/p",
      execute,
    });
    const at = (cwd: string) => ({ cwd, env: {} });
    try {
      expect(recognised("pytest -x", at("/p"))).toBe(true);
      expect(recognised("pytest -x", at("/q"))).toBe(false);
      expect(recognised("pytest -x && ls", at("/p"))).toBe(false);
      expect(await runRecognised("pytest -x", at("/p"))).toBe(true);
      expect(execute).toHaveBeenCalledWith("pytest -x", at("/p"));
      expect(await runRecognised("ls", at("/p"))).toBe(false);
    } finally {
      dispose();
    }
  });
});
