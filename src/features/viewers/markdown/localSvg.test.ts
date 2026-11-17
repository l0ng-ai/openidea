import { describe, expect, it } from "vitest";
import { localSvg } from "./localSvg";

const parse = (svg: string) => {
  const host = document.createElement("div");
  host.append(localSvg(svg));
  return host;
};

describe("localSvg", () => {
  it("keeps what the drawing refers to inside itself", () => {
    const svg =
      `<svg id="m"><style>#m{font-family:"trebuchet ms",verdana;fill:#333}#m .a{fill:url(#m-grad)}</style>` +
      `<defs><marker id="m-arrow"><path d="M0,0L8,4"/></marker></defs>` +
      `<path marker-end="url(#m-arrow)" style="fill:url(data:image/png;base64,AA==)"/>` +
      `<a href="https://example.test/docs"><text>docs</text></a><image href="data:image/png;base64,AA=="/></svg>`;
    const out = parse(svg);
    expect(out.querySelector("style")!.textContent).toBe(
      `#m{font-family:"trebuchet ms",verdana;fill:#333}#m .a{fill:url(#m-grad)}`,
    );
    expect(out.querySelector("path[marker-end]")!.getAttribute("marker-end")).toBe("url(#m-arrow)");
    expect(out.querySelector("path[marker-end]")!.getAttribute("style")).toBe("fill:url(data:image/png;base64,AA==)");
    expect(out.querySelector("a")!.getAttribute("href")).toBe("https://example.test/docs");
    expect(out.querySelector("image")!.getAttribute("href")).toMatch(/^data:/);
  });

  it("keeps the rules between two quoted strings", () => {
    const css = `#m{font-family:"trebuchet ms",verdana}#m .a:hover{fill:#123}#m [id$="-arrow"] path{fill:#456}`;
    expect(parse(`<svg id="m"><style>${css}</style></svg>`).querySelector("style")!.textContent).toBe(css);
  });

  it("drops what would fetch from another host when shown", () => {
    // What `style A fill:url(…)`, `classDef`, and an HTML label put into Mermaid's output.
    const svg =
      `<svg id="m"><style>@import "https://a.test/x.css";#m .c > *{fill:url(https://b.test/1) !important}` +
      `#m .d{background:image-set("//c.test/2" 1x)}#m .e{background:\\75 rl(https://d.test/3)}</style>` +
      `<g style="fill:url( 'https://e.test/4' )"><rect fill="url(https://f.test/5)"/></g>` +
      `<foreignObject><div><img src="https://g.test/6"><img src=" //h.test/7"><img srcset="x.png 1x, https://i.test/8 2x"></div></foreignObject>` +
      `<image href="https://j.test/9"/><use xlink:href="\\\\k.test\\share#x"/></svg>`;
    const out = parse(svg);
    const html = out.innerHTML;
    for (const host of [
      "a.test",
      "b.test",
      "c.test",
      "e.test",
      "f.test",
      "g.test",
      "h.test",
      "i.test",
      "j.test",
      "k.test",
    ]) {
      expect(html).not.toContain(host);
    }
    // The escape that spelled `url` is gone; what is left is no function that fetches.
    expect(out.querySelector("style")!.textContent).not.toMatch(/url\(\s*["']?\s*[^#\s"']/i);
    expect(out.querySelector("style")!.textContent).not.toContain("\\");
  });
});
