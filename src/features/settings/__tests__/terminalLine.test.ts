import { describe, expect, it } from "vitest";
import { terminalLine } from "../languages/api";

describe("terminalLine", () => {
  it.each([
    ["Solving environment: -\b\\\b|\b/\bdone", "Solving environment: done"],
    ["Downloading  10%\rDownloading  55%\rDownloading 100%", "Downloading 100%"],
    ["Collecting pip\r\n", "Collecting pip"],
    ["\x1b[32mSuccessfully installed\x1b[0m six", "Successfully installed six"],
    ["\x1b]0;conda\x07Preparing transaction", "Preparing transaction"],
    ["progress 99%\rdone", "doneress 99%"],
    ["\tindented\x07", "\tindented"],
  ])("renders %j as %j", (raw, line) => expect(terminalLine(raw)).toBe(line));
  it.each(["", "\b\b", "\x1b[2K\r", "   "])("drops %j", (raw) => expect(terminalLine(raw)).toBeNull());
});
