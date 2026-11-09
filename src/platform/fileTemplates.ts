export type NameStyle = "asis" | "snake" | "pascal" | "kebab";

export interface FileTemplateKind {
  id: string;
  label: string;
  body: string;
  /** Overrides the template's extension (Stylesheet › CSS / SCSS / Less). */
  extension?: string;
}

export interface FileTemplate {
  id: string;
  /** Menu label, e.g. "Rust File". */
  name: string;
  icon: string;
  /** Without the dot; empty for "File…" (the name carries the extension). */
  extension: string;
  nameStyle: NameStyle;
  /** Package inference: `jvm` (Java/Kotlin source roots) or `go` (directory). */
  packageStyle?: "jvm" | "go" | "php";
  /** Dotted names (`com.acme.Foo`) create package directories. */
  dottedPackages?: boolean;
  kinds: FileTemplateKind[];
  enabled?: boolean;
  /** Prefilled name for fixed-name files (`Dockerfile`, `.editorconfig`). */
  defaultName?: string;
  /** Exact filename supplied by a plugin; skips the name prompt. */
  fileName?: string;
  variables?: { name: string; prompt: string }[];
  /** Infer package style from the extension using the built-in rules. */
  inferPackage?: boolean;
  /** Reformat according to style: run Reformat Code on the new file (unset: on, as IDEA). */
  reformat?: boolean;
}
