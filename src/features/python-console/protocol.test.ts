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

  it("drops a malformed message line", () => {
    expect(stdoutParser()("a\x1enot json\nb")).toEqual({ text: "ab", messages: [] });
  });
});

it("encodes code as one stdin line", () => {
  expect(request("x = 1\nprint(x)")).toBe('{"code":"x = 1\\nprint(x)"}\n');
});
