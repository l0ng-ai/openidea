import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "./render";
import { subscribeTheme, themeKey } from "@/platform/themeWatch";
import { hasMermaid, renderMermaidIn, resetMermaidForTests } from "./mermaid";

const m = vi.hoisted(() => ({
  loads: 0,
  initialize: vi.fn(),
  render: vi.fn(async (id: string, text: string) => {
    // Like mermaid: a measuring node under <body> while rendering.
    const tmp = document.createElement("div");
    tmp.id = `d${id}`;
    document.body.append(tmp);
    if (text.includes("bad")) throw new Error("Parse error on line 2:\nbad\n^");
    return {
      svg:
        `<svg id="${id}"><style>#${id}{fill:#dad;}#${id} .cluster rect{fill:#2e2f30;}#${id} .flowchart-link{fill:none;}#${id} [id$="-arrow"] path{fill:#9fa2a8;}</style>` +
        `<defs><marker id="${id}-arrow" orient="auto"><path d="M0,0L8,4"/></marker></defs>` +
        `<g class="cluster" id="dad"><rect/></g>` +
        `<path class="flowchart-link" d="M0,4" marker-end="url(#${id}-arrow)"/><text>${text.split("\n")[0]}</text></svg>`,
    };
  }),
}));

vi.mock("mermaid", () => {
  m.loads++;
  return { default: { initialize: m.initialize, render: m.render } };
});

function preview(md: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(md);
  document.body.append(root);
  return root;
}

const SEQ = "```mermaid\nsequenceDiagram\n    A->B:test\n```\n";

async function renderedSvg(svg: string): Promise<SVGSVGElement> {
  m.render.mockResolvedValueOnce({ svg });
  const root = preview(SEQ);
  await renderMermaidIn(root).done;
  return root.querySelector("svg")!;
}

describe("mermaid in the markdown preview", () => {
  beforeEach(() => {
    resetMermaidForTests();
    m.render.mockClear();
    m.initialize.mockClear();
    document.body.innerHTML = "";
  });

  it("emits a placeholder holding the escaped source, other code blocks unchanged", () => {
    const root = preview(
      `# T\n\n${SEQ}\n\`\`\`js\nlet a = 1;\n\`\`\`\n\n\`\`\`Mermaid title\ngraph TD\n  a["<b>x</b>"]-->b\n\`\`\`\n`,
    );
    const blocks = root.querySelectorAll<HTMLElement>("[data-mermaid]");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.parentElement?.dataset.line).toBe("2");
    expect(blocks[0]!.querySelector("pre > code.language-mermaid")?.textContent).toBe("sequenceDiagram\n    A->B:test");
    expect(blocks[1]!.querySelector("code")?.textContent).toContain('a["<b>x</b>"]');
    expect(blocks[1]!.querySelector("b")).toBeNull();
    expect(root.querySelector("code.language-js")?.closest("[data-mermaid]")).toBeNull();
  });

  it("loads mermaid only for previews with a diagram", async () => {
    const plain = preview("# Plain\n\n```js\n1\n```\n");
    expect(hasMermaid(plain)).toBe(false);
    const pass = renderMermaidIn(plain);
    expect(pass.async).toBe(false);
    await pass.done;
    expect(m.loads).toBe(0);

    const root = preview(SEQ);
    expect(hasMermaid(root)).toBe(true);
    await renderMermaidIn(root).done;
    expect(m.loads).toBe(1);
    expect(m.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: "strict", theme: "base", look: "classic" }),
    );
    const block = root.querySelector<HTMLElement>("[data-mermaid]")!;
    expect(block.getAttribute("data-mermaid-state")).toBe("ok");
    expect(block.querySelector(".mermaid-output svg")).not.toBeNull();
    // Temporary nodes mermaid leaves under <body> are removed.
    expect(document.body.querySelector(":scope > [id^='d']")).toBeNull();
  });

  it("shows syntax errors inline next to the source without throwing", async () => {
    const root = preview("```mermaid\nsequenceDiagram\nbad\n```\n");
    await expect(renderMermaidIn(root).done).resolves.toBeUndefined();
    const block = root.querySelector<HTMLElement>("[data-mermaid]")!;
    expect(block.getAttribute("data-mermaid-state")).toBe("error");
    expect(block.querySelector("pre code")?.textContent).toContain("bad");
    const error = block.querySelector(".mermaid-output")!;
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("Parse error on line 2");
    expect(error.querySelector("svg")).toBeNull();
  });

  it("renders with unique ids, reuses results and keeps the old diagram while a new one renders", async () => {
    const first = preview(SEQ);
    await renderMermaidIn(first, []).done;
    const ids = new Set(m.render.mock.calls.map(([id]) => id));

    // Same source again (e.g. an edit elsewhere): drawn synchronously from the cache.
    const previous: Node[] = [];
    const again = preview(SEQ);
    const pass = renderMermaidIn(again, previous);
    expect(pass.async).toBe(false);
    expect(again.querySelector("[data-mermaid-state='ok'] svg")).not.toBeNull();
    expect(m.render).toHaveBeenCalledTimes(1);

    // Edited diagram: the previous drawing stands in until the new one is ready.
    const edited = preview(SEQ.replace("test", "edited"));
    const next = renderMermaidIn(edited, previous);
    expect(next.async).toBe(true);
    expect(edited.querySelector(".mermaid-output svg text")?.textContent).toBe("sequenceDiagram");
    await next.done;
    expect(m.render).toHaveBeenCalledTimes(2);
    ids.add(m.render.mock.calls[1]![0]);
    expect(ids.size).toBe(2);
  });

  it("leaves a diagram it already drew in place on the next pass", async () => {
    const root = preview(SEQ);
    await renderMermaidIn(root, []).done;
    const svg = root.querySelector("svg");
    expect(renderMermaidIn(root, []).async).toBe(false);
    expect(root.querySelector("svg")).toBe(svg);
  });

  it("applies a cached diagram with fresh SVG ids so copies don't share markers", async () => {
    const first = preview(SEQ);
    await renderMermaidIn(first, []).done;
    // Like the first copy sitting in a hidden host: a closed details, another tab.
    first.style.display = "none";
    const second = preview(SEQ);
    const pass = renderMermaidIn(second, []);
    expect(pass.async).toBe(false); // drawn from the cache, no new render
    await pass.done;
    expect(m.render).toHaveBeenCalledTimes(1);
    const idsOf = (svg: Element) => [svg, ...svg.querySelectorAll("[id]")].map((el) => el.getAttribute("id"));
    const a = first.querySelector("svg")!;
    const b = second.querySelector("svg")!;
    const idsA = idsOf(a);
    const idsB = idsOf(b);
    expect(idsA).toHaveLength(3);
    expect(idsB).toHaveLength(3);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    // Every marker reference, `<style>#<svg-id>` rule and `[id$="-arrow"]` suffix rule
    // resolves within its own copy without touching hex colours (`#dad`) in `<style>`.
    for (const svg of [a, b]) {
      const own = new Set(idsOf(svg));
      const rootId = svg.getAttribute("id")!;
      const ref = svg.querySelector("[marker-end]")!.getAttribute("marker-end")!;
      expect(own.has(/url\(#(.+)\)/.exec(ref)![1]!)).toBe(true);
      const css = svg.querySelector("style")!.textContent!;
      expect(css).toContain(`#${rootId}{fill:#dad;}`);
      expect(css).toContain(`#${rootId} .cluster rect{fill:#2e2f30;}`);
      expect(css).toContain(`#${rootId} .flowchart-link{fill:none;}`);
      expect(svg.querySelector("defs [id$='-arrow'] path")).not.toBeNull();
    }
  });

  it.each(["", ".node", ":hover", ">g", "+g", "~g", "[role]", ", rect", " .cluster rect", "\nrect"])(
    "rewrites style selectors followed by %j",
    async (tail) => {
      const svg = await renderedSvg(
        `<svg id="openidea-mermaid-1"><style>#openidea-mermaid-1${tail}{fill:none;}</style></svg>`,
      );
      expect(svg.querySelector("style")!.textContent).toBe(`#${svg.id}${tail}{fill:none;}`);
    },
  );

  it("rewrites fragment links, quoted URLs and marker ids while preserving suffix selectors", async () => {
    const id = "openidea-mermaid-1";
    const marker = `${id}_flowchart-pointEnd`;
    const svg = await renderedSvg(
      `<svg id="${id}" aria-labelledby="title desc" aria-describedby="desc">` +
        `<style>#${id} [id$="-pointEnd"]{fill:#dad;}#${marker}{stroke:#dad;}</style>` +
        `<title id="title">Title</title><desc id="desc">Description</desc>` +
        `<marker id="${marker}"/><g id="dad"/>` +
        `<use href="#${marker}"/><use xlink:href="#${marker}"/>` +
        `<path marker-end="url(#${marker})"/>` +
        `<path marker-end="url('#${marker}')"/>` +
        `<path marker-end='url("#${marker}")'/>` +
        `<path style="marker-end: url( '#${marker}' );"/>` +
        `<style>#${id} path{marker-end:url("#${marker}");}</style></svg>`,
    );
    const markerId = svg.querySelector("marker")!.id;
    expect(markerId).toBe(`${svg.id}_flowchart-pointEnd`);
    expect(svg.querySelector("[id$='-pointEnd']")).not.toBeNull();
    expect(
      [...svg.querySelectorAll("use")].map((el) => el.getAttribute("href") ?? el.getAttribute("xlink:href")),
    ).toEqual([`#${markerId}`, `#${markerId}`]);
    expect([...svg.querySelectorAll("path[marker-end]")].map((el) => el.getAttribute("marker-end"))).toEqual([
      `url(#${markerId})`,
      `url('#${markerId}')`,
      `url("#${markerId}")`,
    ]);
    expect(svg.querySelector("path[style]")!.getAttribute("style")).toBe(`marker-end: url( '#${markerId}' );`);
    expect([...svg.querySelectorAll("style")].map((el) => el.textContent)).toEqual([
      `#${svg.id} [id$="-pointEnd"]{fill:#dad;}#${markerId}{stroke:#dad;}`,
      `#${svg.id} path{marker-end:url("#${markerId}");}`,
    ]);
    expect(svg.getAttribute("aria-labelledby")).toBe(
      `${svg.querySelector("title")!.id} ${svg.querySelector("desc")!.id}`,
    );
    expect(svg.getAttribute("aria-describedby")).toBe(svg.querySelector("desc")!.id);
  });

  it("keeps ids with a shared prefix distinct and leaves unknown references unchanged", async () => {
    const short = "openidea-mermaid-1";
    const long = "openidea-mermaid-10";
    const svg = await renderedSvg(
      `<svg id="${short}"><g id="${long}"/>` +
        `<style>#${short}>g,#${long}:hover{fill:none;}#${long}0{fill:none;}</style>` +
        `<use href="#${short}"/><use href="#${long}"/><use href="#${long}0"/>` +
        `<path marker-end="url('#${long}')"/></svg>`,
    );
    const longId = svg.querySelector("g")!.id;
    expect(longId).toBe(`${svg.id}0`);
    expect([...svg.querySelectorAll("use")].map((el) => el.getAttribute("href"))).toEqual([
      `#${svg.id}`,
      `#${longId}`,
      `#${long}0`,
    ]);
    expect(svg.querySelector("style")!.textContent).toBe(
      `#${svg.id}>g,#${longId}:hover{fill:none;}#${long}0{fill:none;}`,
    );
    expect(svg.querySelector("path")!.getAttribute("marker-end")).toBe(`url('#${longId}')`);
  });

  it("leaves ids in ordinary labels and unrelated attributes untouched", async () => {
    const id = "openidea-mermaid-1";
    const label = `#${id} ${id} id="${id}" href="#${id}" url(#${id})`;
    const svg = await renderedSvg(
      `<svg id="${id}"><text>${label}</text>` +
        `<g data-id="${id}" data-label="#${id}" title="url(#${id})"/>` +
        `<a href="https://example.com/#${id}">Link</a></svg>`,
    );
    expect(svg.querySelector("text")!.textContent).toBe(label);
    expect(svg.querySelector("g")!.getAttribute("data-id")).toBe(id);
    expect(svg.querySelector("g")!.getAttribute("data-label")).toBe(`#${id}`);
    expect(svg.querySelector("g")!.getAttribute("title")).toBe(`url(#${id})`);
    expect(svg.querySelector("a")!.getAttribute("href")).toBe(`https://example.com/#${id}`);
  });

  it("re-renders when switching between built-in palette themes of the same light / dark base", async () => {
    const root = document.documentElement;
    const previous = root.dataset.colorTheme;
    const changed = vi.fn();
    const off = subscribeTheme(changed);
    try {
      root.dataset.colorTheme = "one-dark";
      const firstKey = themeKey();
      await renderMermaidIn(preview(SEQ)).done;
      root.dataset.colorTheme = "solarized-dark";
      await Promise.resolve();
      expect(changed).toHaveBeenCalled();
      expect(themeKey()).not.toBe(firstKey);
      await renderMermaidIn(preview(SEQ)).done;
      expect(m.render).toHaveBeenCalledTimes(2);
    } finally {
      off();
      if (previous === undefined) delete root.dataset.colorTheme;
      else root.dataset.colorTheme = previous;
    }
  });

  it("re-renders when switching between plugin themes of the same light / dark base", async () => {
    const root = document.documentElement;
    const changed = vi.fn();
    const off = subscribeTheme(changed);
    try {
      root.dataset.theme = "dark";
      root.dataset.pluginTheme = "acme-themes/night";
      const firstKey = themeKey();
      await renderMermaidIn(preview(SEQ)).done;
      root.dataset.pluginTheme = "acme-themes/dusk";
      await Promise.resolve();
      expect(changed).toHaveBeenCalled();
      expect(themeKey()).not.toBe(firstKey);
      await renderMermaidIn(preview(SEQ)).done;
      expect(m.render).toHaveBeenCalledTimes(2);
    } finally {
      off();
      delete root.dataset.pluginTheme;
    }
  });

  it("lifts dark-theme shapes off the editor background and paints labels with the foreground", async () => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    root.dataset.theme = "dark";
    const values: Record<string, string> = {
      "--bg-editor": "#191a1c",
      "--bg-elev": "#212326",
      "--bg-floating-toolbar": "#33353b",
      "--bg-selected": "#2a4371",
      "--border-strong": "#40434a",
      "--fg-strong": "#dfe1e5",
      "--fg": "#d1d3d9",
      "--fg-secondary": "#9fa2a8",
      "--accent": "#3871e1",
      "--chart-series": "#e07a7c",
      "--danger": "#f57e84",
    };
    const computed = vi
      .spyOn(globalThis, "getComputedStyle")
      .mockImplementation(
        () => ({ getPropertyValue: (n: string) => values[n] ?? "" }) as unknown as CSSStyleDeclaration,
      );
    try {
      await renderMermaidIn(preview(SEQ)).done;
      expect(m.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          look: "classic",
          themeVariables: expect.objectContaining({
            darkMode: true,
            useGradient: false,
            background: "#191a1c",
            mainBkg: "#33353b",
            nodeBorder: "#dfe1e5",
            primaryBorderColor: "#dfe1e5",
            primaryColor: "#3871e1",
            cScale0: "#3871e1",
            lineColor: "#9fa2a8",
            classText: "#dfe1e5",
          }),
        }),
      );
    } finally {
      computed.mockRestore();
      if (previous === undefined) delete root.dataset.theme;
      else root.dataset.theme = previous;
    }
  });

  it("passes colours a theme writes as hsl() or color-mix() to mermaid as RGB", async () => {
    const values: Record<string, string> = {
      "--bg-editor": "hsl(220, 13%, 18%)",
      "--fg": "color-mix(in srgb, hsl(220, 14%, 71%) 90%, black)",
      "--danger": "#e06c75",
    };
    const resolved: Record<string, string> = {
      "--bg-editor": "rgb(40, 44, 52)",
      "--fg": "color(srgb 0.6 0.62 0.66)",
    };
    let probe = "";
    const computed = vi.spyOn(globalThis, "getComputedStyle").mockImplementation(
      (el) =>
        (el === document.documentElement
          ? { getPropertyValue: (n: string) => values[n] ?? "" }
          : {
              color: resolved[(probe = (el as HTMLElement).style.color.slice(4, -1))] ?? "",
            }) as unknown as CSSStyleDeclaration,
    );
    try {
      await renderMermaidIn(preview(SEQ)).done;
      expect(probe).not.toBe("");
      expect(m.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          themeVariables: expect.objectContaining({
            background: "rgb(40, 44, 52)",
            textColor: "rgb(153, 158, 168)",
            errorTextColor: "#e06c75",
          }),
        }),
      );
      expect(document.querySelector("span[hidden]")).toBeNull();
    } finally {
      computed.mockRestore();
    }
  });

  it("skips superseded renders", async () => {
    const root = preview(SEQ.replace("test", "stale"));
    const pass = renderMermaidIn(root);
    pass.cancel();
    await pass.done;
    expect(m.render).not.toHaveBeenCalled();
    expect(root.querySelector("[data-mermaid]")?.getAttribute("data-mermaid-state")).toBe("pending");
  });
});
