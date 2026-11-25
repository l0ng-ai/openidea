/**
 * Declarative description of the built-in pages. Option labels double as the
 * search index, so a page is found by any of its option names without having
 * to render it.
 */
import type { ComponentType, ReactNode } from "react";
import type { SelectOption } from "@/ui";

export type OptionSpec =
  | {
      kind: "toggle";
      key: string;
      label: string;
      hint?: ReactNode;
      /** Dependent options, indented and disabled while unchecked. */
      children?: Exclude<OptionSpec, { kind: "custom" }>[];
    }
  | {
      kind: "number";
      key: string;
      label: string;
      min: number;
      max: number;
      step?: number;
      integer?: boolean;
      unit?: string;
      hint?: ReactNode;
    }
  | { kind: "select"; key: string; label: string; options: readonly SelectOption[]; hint?: ReactNode }
  | { kind: "text"; key: string; label: string; placeholder?: string; hint?: ReactNode }
  /** Custom control; `label` is still indexed for search. */
  | { kind: "custom"; label: string; keywords?: string[]; component: ComponentType };

export interface SectionSpec {
  title?: string;
  options: OptionSpec[];
}

export interface PageSpec {
  id: string;
  title: string;
  group?: string;
  order: number;
  keywords?: string[];
  /** Offers the Global / This project scope switch. */
  projectScope?: boolean;
  /** Scope shown first with a project open (toolchains belong to the project, like IDEA's project SDK). */
  defaultScope?: "global" | "project";
  /** Pages sharing one scope choice (Code Style and its language pages: the scheme). */
  scopeGroup?: string;
  /** The page picks its scope itself (Code Style's Scheme): no Global / This project switch. */
  ownScopeSwitch?: boolean;
  sections?: SectionSpec[];
  /** Rendered below the sections (previews). */
  footer?: ComponentType;
  /** Fully custom page (Keymap). */
  component?: ComponentType;
  /** Extra search texts computed at search time (e.g. action names). */
  dynamicLabels?: () => string[];
}

/** Search texts of a spec: section titles, option labels and keywords. */
export function specLabels(spec: PageSpec): string[] {
  const out: string[] = [...(spec.keywords ?? [])];
  for (const section of spec.sections ?? []) {
    if (section.title) out.push(section.title);
    for (const o of flattenOptions(section.options)) {
      out.push(o.label);
      if (o.kind === "custom") out.push(...(o.keywords ?? []));
      if (o.kind === "select") out.push(...o.options.map((x) => x.label));
    }
  }
  return out;
}

/** The options and, after each checkbox, its dependent options. */
export function flattenOptions(options: readonly OptionSpec[]): OptionSpec[] {
  return options.flatMap((o) => (o.kind === "toggle" && o.children ? [o, ...flattenOptions(o.children)] : [o]));
}
