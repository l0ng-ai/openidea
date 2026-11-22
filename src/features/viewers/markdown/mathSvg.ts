import { MathJaxTexFont } from "@mathjax/mathjax-tex-font/js/svg.js";
import { AssistiveMmlHandler } from "@mathjax/src/js/a11y/assistive-mml.js";
import { browserAdaptor } from "@mathjax/src/js/adaptors/browserAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { SafeHandler } from "@mathjax/src/js/ui/safe/SafeHandler.js";

function createSvgRenderer() {
  const handler = RegisterHTMLHandler(browserAdaptor());
  SafeHandler<HTMLElement, Text, Document>(handler);
  AssistiveMmlHandler<HTMLElement, Text, Document>(handler);
  const tex = new TeX<HTMLElement, Text, Document>({
    packages: ["base", "ams", "newcommand", "textmacros"],
    formatError: (_jax: unknown, error: unknown) => {
      throw error;
    },
  });
  const math = mathjax.document("", {
    InputJax: tex,
    OutputJax: new SVG({ fontData: MathJaxTexFont, fontCache: "local" }),
    safeOptions: { allow: { URLs: "none", classes: "none", cssIDs: "none", styles: "none" } },
  });
  return (source: string, display: boolean) => {
    tex.reset();
    return math.convert(source, { display, em: 16, ex: 8, containerWidth: 1280 }) as HTMLElement;
  };
}

let convert: ReturnType<typeof createSvgRenderer> | undefined;

export function renderMathSvg(root: HTMLElement) {
  for (const element of root.querySelectorAll<HTMLElement>("[data-math]")) {
    const mode = element.getAttribute("data-math");
    const source = element.textContent?.trim();
    if (!source || (mode !== "inline" && mode !== "display")) continue;
    try {
      convert ??= createSvgRenderer();
      const output = convert(source, mode === "display");
      const svg = output.querySelector("svg");
      if (!svg) continue;
      svg.setAttribute("aria-label", source);
      element.setAttribute("data-math-svg", mode);
      element.removeAttribute("data-math");
      element.replaceChildren(...output.childNodes);
    } catch {
      // Keep unsupported TeX for the existing KaTeX renderer.
    }
  }
}
