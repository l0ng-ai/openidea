import { describe, expect, it } from "vitest";
import { parseShellCommand, quotePath } from "./commandLine";

describe("parseShellCommand", () => {
  it("keeps Windows paths as typed", () => {
    expect(parseShellCommand(String.raw`C:\Windows\system32\cmd.exe`, true)).toEqual([
      String.raw`C:\Windows\system32\cmd.exe`,
    ]);
    expect(parseShellCommand(String.raw`C:\Windows\system32\cmd.exe /k C:\tools\init.bat`, true)).toEqual([
      String.raw`C:\Windows\system32\cmd.exe`,
      "/k",
      String.raw`C:\tools\init.bat`,
    ]);
  });

  it("takes an unquoted Windows path with spaces up to its executable", () => {
    expect(parseShellCommand(String.raw`C:\Program Files\PowerShell\7\pwsh.exe`, true)).toEqual([
      String.raw`C:\Program Files\PowerShell\7\pwsh.exe`,
    ]);
    expect(parseShellCommand(String.raw`C:\Program Files\Git\bin\bash.EXE --login -i`, true)).toEqual([
      String.raw`C:\Program Files\Git\bin\bash.EXE`,
      "--login",
      "-i",
    ]);
  });

  it("honours quotes", () => {
    expect(parseShellCommand(String.raw`"C:\Program Files\Git\bin\bash.exe" --login`, true)).toEqual([
      String.raw`C:\Program Files\Git\bin\bash.exe`,
      "--login",
    ]);
    expect(parseShellCommand(`/bin/zsh --login`, false)).toEqual(["/bin/zsh", "--login"]);
    expect(parseShellCommand(`"/Applications/My Shell/bin/fish" -l`, false)).toEqual([
      "/Applications/My Shell/bin/fish",
      "-l",
    ]);
    expect(parseShellCommand(String.raw`/bin/sh -c a\ b`, false)).toEqual(["/bin/sh", "-c", "a b"]);
  });

  it("is empty for an empty setting", () => {
    expect(parseShellCommand("  ", true)).toEqual([]);
    expect(parseShellCommand("", false)).toEqual([]);
  });
});

describe("quotePath", () => {
  it("quotes only paths with whitespace", () => {
    expect(quotePath(String.raw`C:\Windows\system32\cmd.exe`)).toBe(String.raw`C:\Windows\system32\cmd.exe`);
    expect(quotePath(String.raw`C:\Program Files\PowerShell\7\pwsh.exe`)).toBe(
      String.raw`"C:\Program Files\PowerShell\7\pwsh.exe"`,
    );
    expect(parseShellCommand(quotePath("/Applications/My Shell/fish"), false)).toEqual(["/Applications/My Shell/fish"]);
  });
});
