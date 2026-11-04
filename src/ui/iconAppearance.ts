import { create } from "zustand";
import type { FileIconThemeOptions } from "@/bindings";

const MONO_FILTER_ID = "oi-icon-mono";
const MAX_SATURATION = 20;
const MONO_GAIN = 1.4;
const MONO_LIFT = 0.15;
const LUMA = [0.2126, 0.7152, 0.0722] as const;
const SVG_NS = "http://www.w3.org/2000/svg";

export const useIconRowHeight = create<number | null>(() => null);

function monoMatrix(hex: string): string {
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
  const rows = [channel(1), channel(3), channel(5)].map((c) =>
    [...LUMA.map((l) => (c * MONO_GAIN * l).toFixed(4)), "0", (c * MONO_LIFT).toFixed(4)].join(" "),
  );
  return [...rows, "0 0 0 1 0"].join(" ");
}

function monoFilter(hex: string) {
  let matrix = document.querySelector<SVGFEColorMatrixElement>(`#${MONO_FILTER_ID} feColorMatrix`);
  if (!matrix) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    const filter = document.createElementNS(SVG_NS, "filter");
    filter.id = MONO_FILTER_ID;
    filter.setAttribute("color-interpolation-filters", "sRGB");
    matrix = document.createElementNS(SVG_NS, "feColorMatrix");
    matrix.setAttribute("type", "matrix");
    filter.append(matrix);
    svg.append(filter);
    document.body.append(svg);
  }
  matrix.setAttribute("values", monoMatrix(hex));
}

function setVar(name: string, flag: string, value: string | null) {
  const root = document.documentElement;
  if (value === null) {
    root.style.removeProperty(name);
    delete root.dataset[flag];
  } else {
    root.style.setProperty(name, value);
    root.dataset[flag] = "";
  }
}

function iconFilter(o: FileIconThemeOptions | null): string | null {
  const parts: string[] = [];
  if (o?.monochrome) {
    monoFilter(o.monochrome);
    parts.push(`url(#${MONO_FILTER_ID})`);
  }
  if (o?.saturation) parts.push(`saturate(${1 - o.saturation / MAX_SATURATION})`);
  return parts.length ? parts.join(" ") : null;
}

export function setIconAppearance(o: FileIconThemeOptions | null): void {
  useIconRowHeight.setState(o?.rowHeight ?? null, true);
  if (typeof document === "undefined") return;
  setVar("--oi-icon-filter", "oiIconFilter", iconFilter(o));
  setVar("--oi-icon-opacity", "oiIconOpacity", o?.opacity ? String(o.opacity / 100) : null);
  setVar("--oi-icon-accent", "oiAccent", o?.accent ?? null);
  setVar("--oi-tree-icon-size", "oiTreeIconSize", o?.iconSize ? `${o.iconSize}px` : null);
}
