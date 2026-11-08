import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { bodyKind, formatMs, formatSize, prettyBody, prettyMarkup } from "./format";
import { httpLanguage } from "./language";

describe("response bodies", () => {
  it("detects the kind from the content type, else the content", () => {
    expect(bodyKind("application/json; charset=utf-8", "x")).toBe("json");
    expect(bodyKind("application/problem+json", "x")).toBe("json");
    expect(bodyKind("text/html", "")).toBe("html");
    expect(bodyKind("application/xml", "")).toBe("xml");
    expect(bodyKind(null, ' {"a":1}')).toBe("json");
    expect(bodyKind(null, "{not json")).toBe("text");
    expect(bodyKind(null, "<!DOCTYPE html><html></html>")).toBe("html");
    expect(bodyKind(null, "<?xml version='1.0'?><a/>")).toBe("xml");
    expect(bodyKind(null, "plain")).toBe("text");
  });

  it("pretty-prints JSON and leaves invalid JSON alone", () => {
    expect(prettyBody("json", '{"a":[1,2],"b":null}')).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": null\n}');
    expect(prettyBody("json", "{oops")).toBe("{oops");
  });

  it("re-indents XML, keeping text-only elements on one line", () => {
    expect(prettyMarkup('<?xml version="1.0"?><a><b>1</b><c/><d><e>x</e></d><f></f></a>')).toBe(
      [
        '<?xml version="1.0"?>',
        "<a>",
        "  <b>1</b>",
        "  <c/>",
        "  <d>",
        "    <e>x</e>",
        "  </d>",
        "  <f></f>",
        "</a>",
      ].join("\n"),
    );
  });

  it("re-indents HTML with void elements and raw script contents", () => {
    const html =
      "<html><head><meta charset=utf-8><script>if (a < b) { x(); }</script></head><body><p>Hi</p><br></body></html>";
    expect(prettyMarkup(html, true)).toBe(
      [
        "<html>",
        "  <head>",
        "    <meta charset=utf-8>",
        "    <script>if (a < b) { x(); }</script>",
        "  </head>",
        "  <body>",
        "    <p>Hi</p>",
        "    <br>",
        "  </body>",
        "</html>",
      ].join("\n"),
    );
  });

  it("formats sizes and durations", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(null)).toBe("0 B");
    expect(formatMs(12.4)).toBe("12 ms");
    expect(formatMs(1500)).toBe("1.50 s");
  });
});

describe("http highlighting", () => {
  function tokens(text: string): Array<[string, string]> {
    const state = EditorState.create({ doc: text, extensions: httpLanguage });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
    const out: Array<[string, string]> = [];
    tree.iterate({
      enter: (n) => {
        if (n.name !== "Document" && n.from < n.to) out.push([n.name, state.sliceDoc(n.from, n.to)]);
      },
    });
    return out;
  }

  it.each([
    ["GRPC", "localhost:9003/example.Greeter/SayHello"],
    ["WEBSOCKET", "ws://localhost:8080/events"],
    ["PROPFIND", "https://example.test/collection"],
    ["M-SEARCH", "http://example.test/devices"],
  ])("highlights %s request lines and their JSON bodies", (method, url) => {
    const t = tokens(
      `### Request with body\n${method} ${url}\nContent-Type: application/json\n\n{"name": "World", "count": 12, "enabled": true}\n`,
    );
    expect(t).toContainEqual(["keyword", method]);
    expect(t).toContainEqual(["link", url]);
    expect(t).toContainEqual(["propertyName", "Content-Type"]);
    expect(t).toContainEqual(["propertyName", '"name"']);
    expect(t).toContainEqual(["string", '"World"']);
    expect(t).toContainEqual(["number", "12"]);
    expect(t).toContainEqual(["bool", "true"]);
  });

  it.each(["https://example.test/items", "/items", "{{endpoint}}", "{{host}}/items"])(
    "recognizes a bare request target %s before entering the body",
    (url) => {
      const t = tokens(`${url}\n\n{"count": 12, "enabled": false}\n`);
      expect(t[0]?.[0]).toContain(url.startsWith("{{") ? "variableName" : "link");
      expect(t).toContainEqual(["propertyName", '"count"']);
      expect(t).toContainEqual(["number", "12"]);
      expect(t).toContainEqual(["bool", "false"]);
    },
  );

  it("resets request state across protocol changes and keeps variable declarations", () => {
    const t = tokens(
      '@host = localhost\n### RPC\nGRPC {{host}}:9003/example.Greeter/SayHello\n\n{"count": 1}\n### HTTP\nPOST https://example.test/messages\n\n{"count": 2}\n### Socket\nWEBSOCKET ws://{{host}}/events\n\n{"count": 3}',
    );
    expect(t.filter(([name]) => name === "keyword").map(([, text]) => text)).toEqual(["GRPC", "POST", "WEBSOCKET"]);
    expect(t.filter(([name]) => name === "number").map(([, text]) => text)).toEqual(["1", "2", "3"]);
    expect(t.some(([name, text]) => name.includes("variableName") && text === "@host")).toBe(true);
  });

  it("distinguishes JSON keys, values, arrays and primitive literals", () => {
    const t = tokens(
      'POST https://example.test/items\n\n{"name": "World", "fraction": -1.25e+3, "enabled": true, "empty": null, "items": [1, false, {"nested": "yes"}]}',
    );
    expect(t).toContainEqual(["propertyName", '"name"']);
    expect(t).toContainEqual(["string", '"World"']);
    expect(t).toContainEqual(["propertyName", '"nested"']);
    expect(t).toContainEqual(["number", "-1.25e+3"]);
    expect(t).toContainEqual(["bool", "true"]);
    expect(t).toContainEqual(["bool", "false"]);
    expect(t).toContainEqual(["null", "null"]);
    expect(t.some(([name, text]) => name === "brace" && text.includes("{"))).toBe(true);
    expect(t).toContainEqual(["squareBracket", "["]);
    expect(t.some(([name, text]) => name === "separator" && text.includes(":"))).toBe(true);
  });

  it("tags separators, methods, URLs, headers, variables and comments", () => {
    const t = tokens('### Users\n# @name list\nGET https://{{host}}/users\nAccept: json\n\n{"a": 1}\n');
    const has = (name: string, text: string) => t.some(([n, s]) => n.includes(name) && s === text);
    expect(has("heading", "### Users")).toBe(true);
    expect(has("keyword", "GET")).toBe(true);
    expect(has("link", "https://")).toBe(true);
    expect(has("variableName", "{{host}}")).toBe(true);
    expect(has("propertyName", "Accept")).toBe(true);
    expect(has("string", " json")).toBe(true);
    expect(has("propertyName", '"a"')).toBe(true);
    expect(has("number", "1")).toBe(true);
    expect(has("meta", "# @name")).toBe(true);
  });
});
