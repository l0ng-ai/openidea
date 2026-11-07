import type { RunTarget } from "./targets";

interface Token {
  text: string;
  line: number;
  literal?: string;
}

const goSubtestName = (name: string) => name.replace(/\s/g, "_");

function stringValue(text: string): string {
  if (text.startsWith("`")) return text.slice(1, -1).replace(/\r/g, "");
  return text
    .slice(1, -1)
    .replace(/\\(U[\da-fA-F]{8}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|[0-7]{3}|.)/gs, (_, escape: string) => {
      if (/^[Uux]/.test(escape)) {
        const point = parseInt(escape.slice(1), 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : escape;
      }
      if (/^[0-7]{3}$/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
      return (
        ({ a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" } as Record<string, string>)[escape] ??
        escape
      );
    });
}

/** Ignore comments and literal contents when matching Go's declaration and callback boundaries. */
export function goTargets(text: string): RunTarget[] {
  const tokens: Token[] = [];
  const out: RunTarget[] = [];
  let line = 0;
  for (const match of text.matchAll(
    /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|`[^`]*`|'(?:[^'\\]|\\.)*'|[\p{L}_][\p{L}\p{N}_]*|:=|\S/gu,
  )) {
    const word = match[0];
    if (/^\/\/go:generate[ \t]+\S/.test(word) && (match.index === 0 || text[match.index - 1] === "\n"))
      out.push({
        line,
        kind: "generate",
        name: word.replace(/^\/\/go:generate[ \t]+/, "").trim(),
        path: [String(line)],
      });
    if (!/^\s|^\/\//.test(word) && !word.startsWith("/*"))
      tokens.push({ text: word, line, ...(/^["`]/.test(word) ? { literal: stringValue(word) } : {}) });
    line += (word.match(/\n/g) ?? []).length;
  }
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  tokens.forEach((token, i) => {
    if (["(", "{", "["].includes(token.text)) stack.push(i);
    else if ([")", "}", "]"].includes(token.text)) {
      const start = stack.pop();
      if (start !== undefined) pairs.set(start, i);
    }
  });
  const aliases = new Set(["testing"]);
  tokens.forEach((token, i) => {
    if (token.literal === "testing") {
      const previous = tokens[i - 1]?.text;
      if (previous && !["import", "("].includes(previous)) aliases.add(previous);
    }
  });
  const parameter = (start: number, end: number, type: string) => {
    const params = tokens.slice(start + 1, end).filter((token) => token.text !== ",");
    const star = params.findIndex((token) => token.text === "*");
    if (star < 0 || star > 1) return null;
    const tail = params.slice(star + 1).map((token) => token.text);
    const valid = tail.length === 3 && aliases.has(tail[0]!) && tail[1] === "." && tail[2] === type;
    const dot = aliases.has(".") && tail.length === 1 && tail[0] === type;
    return valid || dot ? (star === 1 ? params[0]!.text : "") : null;
  };
  const add = (at: number, path: string[]) => {
    if (!out.some((target) => target.line === at && target.path.join("/") === path.join("/")))
      out.push({ line: at, kind: "test", name: path.join("/"), path });
  };
  const subtests = (start: number, end: number, path: string[], receiver: string, type: string) => {
    if (!receiver) return;
    for (let i = start; i < end; i++) {
      if (
        tokens[i]?.text !== receiver ||
        tokens[i + 1]?.text !== "." ||
        tokens[i + 2]?.text !== "Run" ||
        tokens[i + 3]?.text !== "("
      )
        continue;
      const close = pairs.get(i + 3);
      if (close === undefined) continue;
      const arg = tokens[i + 4]!;
      const names: { line: number; name: string }[] = [];
      if (arg.literal !== undefined) names.push({ line: tokens[i]!.line, name: arg.literal });
      else {
        const field = tokens[i + 5]?.text === "." ? tokens[i + 6]?.text : undefined;
        const keyed =
          !field &&
          tokens.slice(start, i).some((token, n, before) => token.text === "for" && before[n + 1]?.text === arg.text);
        for (let n = start; n < end; n++) {
          const value = tokens[n]!;
          if (field && value.text === field && tokens[n + 1]?.text === ":" && tokens[n + 2]?.literal !== undefined)
            names.push({ line: value.line, name: tokens[n + 2]!.literal! });
          if (keyed && value.literal !== undefined && tokens[n + 1]?.text === ":" && tokens[n + 2]?.text === "{")
            names.push({ line: value.line, name: value.literal });
        }
      }
      const paths = names.map(({ line, name }) => {
        const child = [...path, ...goSubtestName(name).split("/")];
        add(line, child);
        return child;
      });
      const relative = tokens.slice(i + 5, close).findIndex((token) => token.text === "func");
      const callback = relative < 0 ? -1 : i + 5 + relative;
      const paramsEnd = pairs.get(callback + 1);
      const body = paramsEnd === undefined ? undefined : paramsEnd + 1;
      const bodyEnd = body === undefined ? undefined : pairs.get(body);
      if (callback >= 0 && paramsEnd !== undefined && body !== undefined && bodyEnd !== undefined) {
        const childReceiver = parameter(callback + 1, paramsEnd, type);
        if (childReceiver !== null) paths.forEach((child) => subtests(body + 1, bodyEnd, child, childReceiver, type));
      }
      i = close;
    }
  };
  const main = tokens.some((token, i) => token.text === "package" && tokens[i + 1]?.text === "main");
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.text !== "func" || tokens[i + 2]?.text !== "(") continue;
    const name = tokens[i + 1]!.text;
    const paramsEnd = pairs.get(i + 2);
    if (paramsEnd === undefined || tokens[paramsEnd + 1]?.text !== "{") continue;
    const end = pairs.get(paramsEnd + 1);
    if (end === undefined) continue;
    const prefix = /^(Test|Benchmark|Example|Fuzz)(.*)$/u.exec(name);
    if (prefix && name !== "TestMain" && !/^\p{Ll}/u.test(prefix[2]!)) {
      const type = prefix[1] === "Benchmark" ? "B" : prefix[1] === "Fuzz" ? "F" : "T";
      const receiver = parameter(i + 2, paramsEnd, type);
      if ((prefix[1] === "Example" && paramsEnd === i + 3) || (prefix[1] !== "Example" && receiver !== null)) {
        add(tokens[i]!.line, [name]);
        if (prefix[1] === "Test" || prefix[1] === "Benchmark")
          subtests(paramsEnd + 2, end, [name], receiver ?? "", type);
      }
    } else if (main && name === "main" && paramsEnd === i + 3)
      out.push({ line: tokens[i]!.line, kind: "main", name: "main", path: [] });
    i = end;
  }
  return out.sort((a, b) => a.line - b.line);
}
