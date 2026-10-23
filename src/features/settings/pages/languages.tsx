/**
 * PyCharm's top-level "Python" group (Interpreter), "Project Structure", and
 * Languages & Frameworks › Go / Java / Node.js / Rust / TypeScript. Pages live in
 * `../languages/`; settings are `languages.*` / `projectStructure.*`.
 */
import { GoPage, JavaPage, NodePage, RustPage, TypeScriptPage } from "../languages/LanguagePages";
import { ProjectStructurePage } from "../languages/ProjectStructurePage";
import { PythonInterpreterPage } from "../languages/PythonInterpreterPage";
import type { PageSpec } from "./spec";

export const LANGUAGES_GROUP = "Languages & Frameworks";

export const LANGUAGE_PAGES: PageSpec[] = [
  {
    id: "python.interpreter",
    title: "Python Interpreter",
    group: LANGUAGES_GROUP,
    order: 403,
    keywords: [
      "python interpreter",
      "sdk",
      "virtualenv",
      "venv",
      "conda",
      "pyenv",
      "packages",
      "pip",
      "install package",
      "add interpreter",
      "activate virtualenv",
    ],
    component: PythonInterpreterPage,
  },
  {
    id: "projectStructure",
    title: "Project Structure",
    // IntelliJ IDEA order: … Version Control, Project Structure, Build, Execution, Deployment, Languages & Frameworks …
    order: 350,
    keywords: ["content root", "sources root", "test sources", "resources", "excluded", "mark directory as"],
    component: ProjectStructurePage,
  },
  {
    id: "languages.go",
    title: "Go",
    group: LANGUAGES_GROUP,
    order: 390,
    keywords: ["goroot", "gopath", "go sdk", "gopls"],
    component: GoPage,
  },
  {
    id: "languages.java",
    title: "Java",
    group: LANGUAGES_GROUP,
    order: 395,
    keywords: ["jdtls", "jvm options", "vmargs", "lombok", "javaagent", "eclipse jdt"],
    component: JavaPage,
  },
  {
    id: "languages.node",
    title: "Node.js",
    group: LANGUAGES_GROUP,
    order: 402,
    keywords: ["node interpreter", "package manager", "npm", "pnpm", "yarn", "bun", "nvm"],
    component: NodePage,
  },
  {
    id: "languages.rust",
    title: "Rust",
    group: LANGUAGES_GROUP,
    order: 404,
    keywords: [
      "toolchain",
      "rustup",
      "standard library",
      "external linter",
      "clippy",
      "cargo check",
      "rustfmt",
      "rust-analyzer",
    ],
    component: RustPage,
  },
  {
    id: "languages.typescript",
    title: "TypeScript",
    group: LANGUAGES_GROUP,
    order: 405,
    keywords: ["typescript version", "tsdk", "tsserver", "node_modules", "vtsls"],
    component: TypeScriptPage,
  },
];
