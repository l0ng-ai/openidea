import { describe, expect, it } from "vitest";
import { request, stdoutParser } from "./protocol";

describe("stdoutParser", () => {
  it("separates driver messages from output", () => {
    const parse = stdoutParser();
    expect(parse('Out[1]: 2\n\x1e{"done":{"variables":[]}}\nafter')).toEqual({
      text: "Out[1]: 2\nafter",
      messages: [{ done: { variables: [] } }],
    });
  });

  it("waits for a message cut across chunks", () => {
    const parse = stdoutParser();
    expect(parse('hi\x1e{"ready":{"vers')).toEqual({ text: "hi", messages: [] });
    expect(parse('ion":"3.12.1","ipython":null}}\n')).toEqual({
      text: "",
      messages: [{ ready: { version: "3.12.1", ipython: null } }],
    });
  });

  it("keeps a line that only looks like a message as output", () => {
    expect(stdoutParser()("a\x1enot json\nb")).toEqual({ text: "a\x1enot json\nb", messages: [] });
  });

  it("reads the message after output that printed \\x1e without ending its line", () => {
    const parse = stdoutParser();
    expect(parse("x\x1ey")).toEqual({ text: "x", messages: [] });
    expect(parse('\x1e{"done":{"variables":[]}}\n')).toEqual({
      text: "\x1ey",
      messages: [{ done: { variables: [] } }],
    });
  });
});

it("encodes code as one stdin line", () => {
  expect(request("x = 1\nprint(x)")).toBe('{"code":"x = 1\\nprint(x)"}\n');
});
