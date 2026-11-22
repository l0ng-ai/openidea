import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { formatJsonBody, httpBodyFormatter } from "./bodyFormat";

describe("formatJsonBody", () => {
  it("indents objects and arrays and keeps values as written", () => {
    expect(formatJsonBody('{"id":12345678901234567890,"tags":["a","b"],"meta":{},"list":[],"ok":true}', "  ")).toBe(
      [
        "{",
        '  "id": 12345678901234567890,',
        '  "tags": [',
        '    "a",',
        '    "b"',
        "  ],",
        '  "meta": {},',
        '  "list": [],',
        '  "ok": true',
        "}",
      ].join("\n"),
    );
  });

  it("keeps {{variables}} as values, quoted or not", () => {
    expect(formatJsonBody('{"user":{{userId}},"name":"{{name}}", "n": {{base}}-1}', "  ")).toBe(
      ["{", '  "user": {{userId}},', '  "name": "{{name}}",', '  "n": {{base}}-1', "}"].join("\n"),
    );
  });

  it("keeps escaped quotes and structural characters inside strings", () => {
    expect(formatJsonBody('{"q":"a \\"b\\" {c}, [d]: e"}', "  ")).toBe('{\n  "q": "a \\"b\\" {c}, [d]: e"\n}');
  });

  it("leaves text that isn't one JSON value alone", () => {
    for (const text of ['{"a":1', '{"a":1}}', '{"a" 1}', "{a:1}", '{"a":1} {"b":2}', "[1,]", "name=value"])
      expect(formatJsonBody(text, "  ")).toBeNull();
  });
});

describe("Reformat Code in .http files (#4727)", () => {
  const blocksOf = (text: string) => {
    const lines = text.split("\n");
    const out: Array<{ line: number; endLine: number }> = [];
    lines.forEach((l, i) => {
      if (/^(GET|POST|PUT|PATCH|DELETE) /.test(l)) out.push({ line: i, endLine: lines.length - 1 });
    });
    out.forEach((b, i) => {
      const next = out[i + 1];
      if (next) b.endLine = next.line - 2;
    });
    return out;
  };
  const format = (text: string, range: { from: number; to: number } | null = null) => {
    const state = EditorState.create({ doc: text, extensions: [indentUnit.of("  ")] });
    const changes = httpBodyFormatter(() => blocksOf(text))(state, range);
    return state.update({ changes }).state.doc.toString();
  };

  it("formats JSON bodies after the headers and keeps the rest of the request", () => {
    const text = [
      "POST https://example.com/api/users",
      "    ?debug=true",
      "Content-Type: application/json",
      "Authorization: Bearer {{token}}",
      "",
      '{"name":"Ann","roles":["admin"],"id":{{id}}}',
      "",
      "> {%",
      '  client.global.set("id", response.body.id);',
      "%}",
      "",
      "###",
      "GET https://example.com/api/users/1",
    ].join("\n");
    expect(format(text)).toBe(
      [
        "POST https://example.com/api/users",
        "    ?debug=true",
        "Content-Type: application/json",
        "Authorization: Bearer {{token}}",
        "",
        "{",
        '  "name": "Ann",',
        '  "roles": [',
        '    "admin"',
        "  ],",
        '  "id": {{id}}',
        "}",
        "",
        "> {%",
        '  client.global.set("id", response.body.id);',
        "%}",
        "",
        "###",
        "GET https://example.com/api/users/1",
      ].join("\n"),
    );
  });

  it("leaves bodies of other content types, form bodies and file inputs alone", () => {
    for (const text of [
      'POST https://example.com\nContent-Type: text/plain\n\n{"a":1}',
      "POST https://example.com\nContent-Type: application/x-www-form-urlencoded\n\na=1&b=2",
      "POST https://example.com\nContent-Type: application/json\n\n< ./body.json",
    ])
      expect(format(text)).toBe(text);
  });

  it("formats only the bodies a selection touches", () => {
    const one = 'POST https://example.com/a\n\n{"a":1}';
    const two = 'POST https://example.com/b\n\n{"b":2}';
    const text = `${one}\n\n###\n${two}`;
    const from = text.indexOf('{"b"');
    expect(format(text, { from, to: from + 3 })).toBe(`${one}\n\n###\nPOST https://example.com/b\n\n{\n  "b": 2\n}`);
  });
});
