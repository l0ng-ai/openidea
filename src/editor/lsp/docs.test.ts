import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";

const signatureNameTarget = vi.fn(async (_decl: unknown, name: string, _lines: number) =>
  name === "Item" ? { path: "/w/src/model.rs", line: 4, col: 11 } : null,
);
vi.mock("./docLinks/signature", () => ({ signatureNameTarget }));

const { linkSignatureTypes } = await import("./docs");

describe("signature names", () => {
  it("resolve in the signature blocks only, and look like links once they lead somewhere", async () => {
    const dom = document.createElement("div");
    // rust-analyzer: module path, signature, rule, docs with an example.
    dom.innerHTML =
      '<pre><code class="language-rust">inventory</code></pre>' +
      '<pre><code class="language-rust">pub fn take(<span class="tok-variableName tok-definition">items</span>: ' +
      '<span class="tok-typeName">Vec</span>&lt;<span class="tok-typeName">Item</span>&gt;)</code></pre>' +
      '<hr><p>Takes them.</p><pre><code class="language-rust"><span class="tok-typeName">Item</span></code></pre>';
    const decl = { path: "/w/src/lib.rs", range: { start: { line: 3, col: 7 }, end: { line: 3, col: 11 } } };
    linkSignatureTypes(dom, "window", {
      markup: { kind: "markdown", value: "" },
      language: null,
      source: async () => decl,
    });
    const [items, vec, item, example] = [...dom.querySelectorAll("span")];
    for (const el of [items!, vec!, item!, example!]) fireEvent.mouseOver(el);
    await vi.waitFor(() => expect(item!.hasAttribute("data-doc-ref")).toBe(true));
    expect(vec!.hasAttribute("data-doc-ref")).toBe(false);
    expect(signatureNameTarget.mock.calls.map((c) => c[1])).toEqual(["Vec", "Item"]);
    expect(signatureNameTarget).toHaveBeenCalledWith(decl, "Item", 1);
  });

  it("include the block closing the documentation after a rule (clangd)", async () => {
    signatureNameTarget.mockClear();
    const dom = document.createElement("div");
    dom.innerHTML =
      "<h3>function take</h3><hr><p>Takes them.</p><hr>" +
      '<pre><code class="language-cpp">void take(<span class="tok-typeName">Item</span> i)</code></pre>';
    const decl = { path: "/w/take.cpp", range: { start: { line: 1, col: 5 }, end: { line: 1, col: 9 } } };
    linkSignatureTypes(dom, "window", {
      markup: { kind: "markdown", value: "" },
      language: null,
      source: async () => decl,
    });
    fireEvent.mouseOver(dom.querySelector("span")!);
    await vi.waitFor(() => expect(dom.querySelector("[data-doc-ref]")?.textContent).toBe("Item"));
  });
});
