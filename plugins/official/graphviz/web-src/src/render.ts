/**
 * The preview's logic apart from the page: rendering options, Graphviz's
 * messages as problems, export names. Kept free of the DOM so it is tested
 * against the real Graphviz in Node.
 */
import type { RenderOptions, RenderResult } from "@viz-js/viz";

/** Layout engines offered, the default first. */
export const ENGINES = ["dot", "neato", "fdp", "sfdp", "circo", "twopi", "osage", "patchwork"] as const;
export type Engine = (typeof ENGINES)[number];

export interface Problem {
  /** 1-based, when Graphviz names one. */
  line: number | null;
  message: string;
  level: "error" | "warning";
}

/**
 * Defaults a graph can still override: transparent background and the IDE's
 * text colour, so an unstyled graph reads in a dark theme too. Exports use
 * none of them (`null`): they look as Graphviz draws them.
 */
export function renderOptions(engine: Engine, foreground: string | null): RenderOptions {
  const options: RenderOptions = { format: "svg", engine };
  const color = foreground && graphvizColor(foreground);
  if (color) {
    options.graphAttributes = { bgcolor: "transparent", color, fontcolor: color };
    options.nodeAttributes = { color, fontcolor: color };
    options.edgeAttributes = { color, fontcolor: color };
  }
  return options;
}

/**
 * A CSS colour as Graphviz reads it (`#rrggbb[aa]`): the theme's variables
 * are `rgb()` / `rgba()`, which it doesn't know. `null` when not one.
 */
export function graphvizColor(css: string): string | null {
  const hex = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, "0");
  const value = css.trim();
  if (/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return value.toLowerCase();
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(value);
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return `#${hex(+m[1]!)}${hex(+m[2]!)}${hex(+m[3]!)}${alpha < 1 ? hex(alpha * 255) : ""}`;
}

/** What Graphviz reported, as problems (on the line it names, if any). */
export function problemsOf(result: RenderResult): Problem[] {
  return result.errors.map((e) => {
    const line = /\bline (\d+)\b/.exec(e.message);
    return {
      line: line ? Number(line[1]) : null,
      message: e.message.replace(/^(Error|Warning):\s*/i, "").trim(),
      level: e.level === "warning" ? "warning" : "error",
    };
  });
}

/** The name an export starts with: the file's, without `.dot` / `.gv`. */
export function exportName(file: string, extension: string): string {
  const base = file.replace(/\.(dot|gv)$/i, "") || "graph";
  return `${base}.${extension}`;
}
