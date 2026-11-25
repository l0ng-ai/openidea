import { afterEach, expect, it, vi } from "vitest";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  notifications: () => ({ notify }),
}));

import { stripAnsi } from "@/ui/ansi";
import { clearConsole, logConsole, runOp, useVcsConsole } from "../ops";

afterEach(() => {
  clearConsole();
  notify.mockClear();
});

it("keeps hook output colours in the Git console and its text plain", () => {
  logConsole("err", "\x1b[41;1m FAILED \x1b[49;22m \x1b[1mSomeTest\x1b[22m\n\x1b[31mred on\nstill red\x1b[0m done");
  const [first, second, third] = useVcsConsole.getState().lines;
  expect(first!.text).toBe(" FAILED  SomeTest");
  expect(first!.spans).toEqual([
    { text: " FAILED ", bg: "var(--ansi-red)", bold: true },
    { text: " " },
    { text: "SomeTest", bold: true },
  ]);
  // A colour set on one line carries to the next one of the same output.
  expect(second!.spans).toEqual([{ text: "red on", fg: "var(--ansi-red)" }]);
  expect(third!.spans).toEqual([{ text: "still red", fg: "var(--ansi-red)" }, { text: " done" }]);
});

it("stores lines without escapes as plain text", () => {
  logConsole("out", "plain line");
  expect(useVcsConsole.getState().lines).toEqual([expect.objectContaining({ text: "plain line" })]);
  expect(useVcsConsole.getState().lines[0]!.spans).toBeUndefined();
});

it("shows a failed command's coloured output as plain text in its balloon", async () => {
  await runOp(
    "Commit",
    async () => {
      throw new Error("\x1b[41;1m FAILED \x1b[0m Tests\\Feature\x1b[90m>\x1b[39m it works");
    },
    { refresh: false },
  );
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Commit failed", body: " FAILED  Tests\\Feature> it works" }),
  );
});

it("strips every escape, a cut-off one included", () => {
  expect(stripAnsi("\x1b]0;title\x07a\x1b[2Kb\x1b[1mc\x1b[")).toBe("abc");
});
