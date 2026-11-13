// @vitest-environment node
import { describe, expect, it } from "vitest";
import { goModParser, initialGoModState, type GoModState } from "./gomod";
import { StringStream } from "@codemirror/language";

function tokenize(line: string, state: GoModState) {
  const stream = new StringStream(line, 4, 1);
  const tokens: { text: string; token: string | null }[] = [];
  while (!stream.eol()) {
    const start = stream.pos;
    const kind = goModParser.token(stream, state);
    if (stream.pos > start && kind !== null) {
      tokens.push({ text: stream.string.slice(start, stream.pos), token: kind });
    }
  }
  return tokens;
}

describe("goModParser", () => {
  it("highlights module declaration and go version", () => {
    const state = initialGoModState();

    const line1 = tokenize("module onpay-aplikasi-api", state);
    expect(line1).toEqual([
      { text: "module", token: "keyword" },
      { text: "onpay-aplikasi-api", token: "string" },
    ]);

    const line2 = tokenize("go 1.27.0", state);
    expect(line2).toEqual([
      { text: "go", token: "keyword" },
      { text: "1.27.0", token: "number" },
    ]);
  });

  it("highlights tool, godebug and ignore directives", () => {
    const state = initialGoModState();
    expect(tokenize("tool golang.org/x/tools/cmd/stringer", state)).toEqual([
      { text: "tool", token: "keyword" },
      { text: "golang.org/x/tools/cmd/stringer", token: "string" },
    ]);
    expect(tokenize("tool (", state)[0]).toEqual({ text: "tool", token: "keyword" });
    expect(tokenize("\tgithub.com/air-verse/air", state)).toEqual([
      { text: "github.com/air-verse/air", token: "string" },
    ]);
    tokenize(")", state);
    expect(tokenize("godebug default=go1.21", state)[0]).toEqual({ text: "godebug", token: "keyword" });
    expect(tokenize("ignore ./node_modules", state)[0]).toEqual({ text: "ignore", token: "keyword" });
  });

  it("highlights require blocks with module paths and versions", () => {
    const state = initialGoModState();

    const line1 = tokenize("require (", state);
    expect(line1).toEqual([
      { text: "require", token: "keyword" },
      { text: "(", token: "paren" },
    ]);

    const line2 = tokenize("\tcloud.google.com/go/auth v0.20.0", state);
    expect(line2).toEqual([
      { text: "cloud.google.com/go/auth", token: "string" },
      { text: "v0.20.0", token: "number" },
    ]);

    const line3 = tokenize("\tgithub.com/shopspring/decimal v1.4.0 // indirect", state);
    expect(line3).toEqual([
      { text: "github.com/shopspring/decimal", token: "string" },
      { text: "v1.4.0", token: "number" },
      { text: "// indirect", token: "comment" },
    ]);

    const line4 = tokenize(")", state);
    expect(line4).toEqual([{ text: ")", token: "paren" }]);
  });

  it("highlights replace directive with operator", () => {
    const state = initialGoModState();

    const line = tokenize("replace example.com/foo => ../bar", state);
    expect(line).toEqual([
      { text: "replace", token: "keyword" },
      { text: "example.com/foo", token: "string" },
      { text: "=>", token: "operator" },
      { text: "../bar", token: "string" },
    ]);
  });
});
