import { expect, it } from "vitest";
import { renderMath } from "@/editor/lsp/markdownMath";
import { renderMathSvg } from "./mathSvg";
import { renderMarkdown } from "./render";

it("renders inline and display equations as independent SVGs with accessible MathML", () => {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown("**$`v_0`$** and $v_0$.\n\n$$\nv_0\n$$");
  renderMathSvg(root);

  const inline = root.querySelectorAll('[data-math-svg="inline"] > svg');
  const display = root.querySelectorAll('[data-math-svg="display"] > svg');
  expect(inline).toHaveLength(2);
  expect(display).toHaveLength(1);
  expect(root.querySelector("strong > [data-math-svg] > svg")?.getAttribute("aria-label")).toBe("v_0");
  expect(root.querySelectorAll("mjx-assistive-mml math")).toHaveLength(3);
  expect(
    [...root.querySelectorAll("svg use")].every((use) => {
      const href = use.getAttribute("xlink:href");
      return href?.startsWith("#") && use.closest("svg")?.querySelector(`[id="${href.slice(1)}"]`);
    }),
  ).toBe(true);
});

it("leaves unsupported formulas for KaTeX without enabling TeX links", () => {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(String.raw`$\href{https://example.com}{x}$`);
  renderMathSvg(root);
  expect(root.querySelector('[data-math="inline"]')?.textContent).toBe(String.raw`\href{https://example.com}{x}`);
  renderMath(root);
  expect(root.querySelector(".katex")).not.toBeNull();
  expect(root.querySelector("a")).toBeNull();
});
