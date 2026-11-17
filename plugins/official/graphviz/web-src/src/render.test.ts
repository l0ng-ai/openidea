import { instance } from "@viz-js/viz";
import { describe, expect, it } from "vitest";
import { ENGINES, exportName, graphvizColor, problemsOf, renderOptions, withoutLinks } from "./render";

describe("the preview's rendering", () => {
  it("renders with the theme's colour as a default the graph can override", async () => {
    const viz = await instance();
    const themed = viz.render('digraph { a -> b; c [color="red"] }', renderOptions("dot", "rgb(200, 200, 200)"));
    expect(themed.status).toBe("success");
    const svg = themed.status === "success" ? themed.output : "";
    expect(svg).toContain('stroke="#c8c8c8"');
    expect(svg).toContain('stroke="red"');
    const plain = viz.render("digraph { a -> b }", renderOptions("dot", null));
    expect(plain.status === "success" && plain.output).not.toContain("#c8c8c8");
  });

  it("names the line of a syntax error", async () => {
    const viz = await instance();
    const result = viz.render("digraph {\n  a -> b\n  c -> }\n", renderOptions("dot", null));
    expect(result.status).toBe("failure");
    const [p] = problemsOf(result);
    expect(p).toMatchObject({ line: 3, level: "error" });
    expect(p!.message).toMatch(/syntax error/);
  });

  it("offers only engines this Graphviz has", async () => {
    const viz = await instance();
    for (const e of ENGINES) expect(viz.engines).toContain(e);
  });

  it("turns the theme's colours into Graphviz's", () => {
    expect(graphvizColor("rgb(200, 200, 200)")).toBe("#c8c8c8");
    expect(graphvizColor("rgba(0, 128, 255, 0.5)")).toBe("#0080ff80");
    expect(graphvizColor("rgb(1 2 3 / 50%)")).toBe("#01020380");
    expect(graphvizColor("#ABCDEF")).toBe("#abcdef");
    expect(graphvizColor("var(--x)")).toBeNull();
    expect(renderOptions("dot", "nonsense").nodeAttributes).toBeUndefined();
  });

  it("names exports after the file", () => {
    expect(exportName("flow.dot", "svg")).toBe("flow.svg");
    expect(exportName("Flow.GV", "png")).toBe("Flow.png");
    expect(exportName("", "svg")).toBe("graph.svg");
  });

  it("previews a graph's links without them", async () => {
    const viz = await instance();
    const js = "javascript:alert(1)";
    const graph = `digraph {
      URL="${js}"; target="_top"
      a [URL="${js}" href="https://example.com" label="a href=\\"x\\""]
      a -> b [URL="${js}" edgeURL="${js}" headURL="${js}" tailURL="${js}" labelURL="${js}" label="e" headlabel="h" taillabel="t"]
      subgraph cluster_x { URL="${js}"; c }
    }`;
    const result = viz.render(graph, renderOptions("dot", null));
    const svg = result.status === "success" ? result.output : "";
    expect(svg).toContain(js);
    const preview = withoutLinks(svg);
    expect(preview).not.toMatch(/\s(xlink:)?(href|target)="|javascript:/);
    expect(preview).toContain("a href=&quot;x&quot;");
    expect(preview.match(/<g id="node\d+"/g)).toHaveLength(3);
  });
});
