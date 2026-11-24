import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { mathExtension, renderMath } from "./markdownMath";

const marked = new Marked({ gfm: true, breaks: false }).use(mathExtension());

function parseSafe(md: string): HTMLElement {
  const html = marked.parse(md, { async: false }) as string;
  const root = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["data-math"],
    FORBID_TAGS: ["style", "form"],
    FORBID_ATTR: ["style"],
    RETURN_DOM: true,
  }) as HTMLElement;
  renderMath(root);
  return root;
}

describe("markdown LaTeX math", () => {
  it("renders inline $...$ and avoids currency false positives", () => {
    const root = parseSafe(
      "Energy $E = mc^2$ and CJK 设$x=1$时.\n\nPrices: $5 and $10, or $5-$10, or $ 5 $, or \\$x\\$.",
    );
    expect(root.querySelectorAll(".katex")).toHaveLength(2);
    expect(root.querySelectorAll(".katex-display")).toHaveLength(0);
    const paras = [...root.querySelectorAll("p")];
    expect(paras[1]!.textContent).toBe("Prices: $5 and $10, or $5-$10, or $ 5 $, or $x$.");
  });

  it("renders GitHub-style protected inline math without the backticks", () => {
    const root = parseSafe("Prices $5 and $10, with **$`v_0`$** ($`\\theta`$) and $`\\text{price \\$10}`$.");
    const formulas = [...root.querySelectorAll(".katex annotation")].map((el) => el.textContent);
    expect(formulas).toEqual(["v_0", "\\theta", "\\text{price \\$10}"]);
    expect(root.querySelector("strong .katex annotation")?.textContent).toBe("v_0");
    expect(root.querySelector("p")?.textContent?.startsWith("Prices $5 and $10, with ")).toBe(true);
  });

  it("leaves separate code spans inside dollar signs as code", () => {
    const root = parseSafe("($`x` `y`$)");
    expect(root.querySelector("p")?.innerHTML).toBe("($<code>x</code> <code>y</code>$)");
  });

  it("matches a longer backtick delimiter around math inside emphasis", () => {
    const root = parseSafe("**($``x` + y``$)**");
    expect(root.querySelector("strong .katex annotation")?.textContent).toBe("x` + y");
    expect(root.querySelector("code")).toBeNull();
  });

  it("keeps an unfinished protected delimiter from swallowing a later formula", () => {
    const root = parseSafe("Unfinished $`x` and $y$.");
    expect(root.querySelector("p > code")?.textContent).toBe("x");
    expect(root.querySelector(".katex annotation")?.textContent).toBe("y");
  });

  it("prevents * and _ inside math from triggering emphasis while allowing emphasis around math", () => {
    const root = parseSafe("Formula $(a)_1 + (b)_2$ and $a * b$ and $c * d$, plus **$x^2$**.");
    expect(root.querySelector("em")).toBeNull();
    expect(root.querySelectorAll(".katex")).toHaveLength(4);
    expect(root.querySelector("strong .katex")).not.toBeNull();
  });

  it("renders multi-line, single-line, inline, and adjacent $$...$$ blocks", () => {
    const root = parseSafe(
      "Para\n$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n\n$$E = mc^2$$\n\n$$a$$ and $$b$$",
    );
    expect(root.querySelectorAll(".katex-display")).toHaveLength(4);
    expect(root.querySelector("p")?.textContent).toBe("Para");
    const lastP = [...root.querySelectorAll("p")].at(-1)!;
    expect(lastP.querySelectorAll(".katex-display")).toHaveLength(2);
    expect(lastP.textContent).toContain("and");
  });

  it("renders \\(...\\) and \\[...\\] without breaking escaped links", () => {
    const root = parseSafe("Inline \\(x + y\\).\n\n\\[\nx^2 + y^2 = z^2\n\\]\n\n\\[text\\](https://example.com)");
    expect(root.querySelectorAll(".katex")).toHaveLength(2);
    expect(root.querySelectorAll(".katex-display")).toHaveLength(1);
    const lastP = [...root.querySelectorAll("p")].at(-1)!;
    expect(lastP.textContent).toBe("[text](https://example.com)");
  });

  it("renders ```math code blocks while keeping ```latex and inline code literal", () => {
    const root = parseSafe("```math\n\\int_0^1 x^2 dx\n```\n\n```latex\n$x$\n```\n\nInline `$y$`.");
    expect(root.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(root.querySelector("pre > code.language-latex")?.textContent).toBe("$x$\n");
    expect(root.querySelector("p > code")?.textContent).toBe("$y$");
  });

  it("renders invalid LaTeX as an error node instead of throwing", () => {
    const root = parseSafe("Bad $\\unknowncommand{x}$ and $$\\frac{1$$");
    expect(root.querySelectorAll(".katex")).toHaveLength(1);
    expect(root.querySelector(".katex-error")).not.toBeNull();
    expect(root.textContent).toContain("\\unknowncommand");
  });

  it("blocks unsafe LaTeX trust commands and raw HTML style/script injection", () => {
    const root = parseSafe(
      [
        "$\\href{javascript:alert(1)}{click}$",
        '<div style="position:fixed">x</div>',
        '<span data-math="inline"><img src=x onerror=alert(1)>a</span>',
      ].join("\n\n"),
    );
    expect(root.querySelector("a")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("div[style]")).toBeNull();
    expect(root.querySelectorAll(".katex")).toHaveLength(2);
  });
});
