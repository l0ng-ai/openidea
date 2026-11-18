/**
 * PyCharm's top-level "Python" group (Interpreter) and
 * Languages & Frameworks › Go / Java / Markdown / Node.js / PHP / Rust / TypeScript / Zig. Pages live in
 * `../languages/`; settings are `languages.*` / `projectStructure.*`.
 */
import { GO_BUILD_TAG_SECTIONS, GoBuildTagsPage } from "../languages/GoBuildTags";
import { GO_MODULE_SECTIONS, GoModulesPage } from "../languages/GoModules";
import { lazyPage } from "./lazyPage";
import type { PageSpec } from "./spec";

const PythonInterpreterPage = lazyPage("python.interpreter", () =>
  import("../languages/PythonInterpreterPage").then((m) => m.PythonInterpreterPage),
);
const PythonInterpretersPage = lazyPage("python.interpreters", () =>
  import("../languages/PythonInterpretersPage").then((m) => m.PythonInterpretersPage),
);
const GoPage = lazyPage("languages.go", () => import("../languages/LanguagePages").then((m) => m.GoPage));
const JavaPage = lazyPage("languages.java", () => import("../languages/LanguagePages").then((m) => m.JavaPage));
const NodePage = lazyPage("languages.node", () => import("../languages/LanguagePages").then((m) => m.NodePage));
const MarkdownPage = lazyPage("languages.markdown", () =>
  import("../languages/MarkdownPage").then((m) => m.MarkdownPage),
);
const PrettierPage = lazyPage("languages.prettier", () =>
  import("../languages/FormatterPage").then((m) => m.PrettierPage),
);
const OxfmtPage = lazyPage("languages.oxfmt", () => import("../languages/FormatterPage").then((m) => m.OxfmtPage));
const DocstringsPage = lazyPage("python.docstrings", () =>
  import("../languages/DocstringsPage").then((m) => m.DocstringsPage),
);
const RuffPage = lazyPage("python.ruff", () => import("../languages/FormatterPage").then((m) => m.RuffPage));
const PhpPage = lazyPage("languages.php", () => import("../languages/LanguagePages").then((m) => m.PhpPage));
const RubyPage = lazyPage("languages.ruby", () => import("../languages/LanguagePages").then((m) => m.RubyPage));
const RustPage = lazyPage("languages.rust", () => import("../languages/LanguagePages").then((m) => m.RustPage));
const TypeScriptPage = lazyPage("languages.typescript", () =>
  import("../languages/LanguagePages").then((m) => m.TypeScriptPage),
);
const ZigPage = lazyPage("languages.zig", () => import("../languages/LanguagePages").then((m) => m.ZigPage));

export const LANGUAGES_GROUP = "Languages & Frameworks";

export const LANGUAGE_PAGES: PageSpec[] = [
  {
    // PyCharm's "Python" settings folder: its pages nest under this id.
    id: "python",
    title: "Python",
    group: LANGUAGES_GROUP,
    order: 403,
    keywords: ["python", "interpreters", "dependencies", "packages", "virtualenv", "venv", "ruff"],
  },
  {
    id: "python.interpreter",
    projectScope: true,
    defaultScope: "project",
    title: "Dependencies",
    group: LANGUAGES_GROUP,
    order: 403.1,
    keywords: [
      "python interpreter",
      "project interpreter",
      "interpreter",
      "sdk",
      "virtualenv",
      "venv",
      "conda",
      "pyenv",
      "dependencies",
      "packages",
      "pip",
      "install package",
      "add interpreter",
      "activate virtualenv",
    ],
    component: PythonInterpreterPage,
  },
  {
    id: "python.interpreters",
    title: "All Interpreters",
    group: LANGUAGES_GROUP,
    order: 403,
    keywords: [
      "python interpreters",
      "all interpreters",
      "interpreter list",
      "add interpreter",
      "remove interpreter",
      "delete interpreter",
      "hide other projects",
      "show interpreter paths",
      "sdk",
      "virtualenv",
      "venv",
      "conda",
      "pyenv",
      "poetry",
      "uv",
    ],
    component: PythonInterpretersPage,
  },
  {
    id: "languages.go",
    projectScope: true,
    defaultScope: "project",
    title: "Go",
    group: LANGUAGES_GROUP,
    order: 390,
    keywords: ["goroot", "gopath", "go sdk", "gopls"],
    component: GoPage,
  },
  {
    id: "languages.go.buildTags",
    title: "Build Tags",
    group: LANGUAGES_GROUP,
    order: 391,
    projectScope: true,
    defaultScope: "project",
    ownScopeSwitch: true,
    sections: GO_BUILD_TAG_SECTIONS,
    component: GoBuildTagsPage,
  },
  {
    id: "languages.go.modules",
    title: "Go Modules",
    group: LANGUAGES_GROUP,
    order: 392,
    projectScope: true,
    defaultScope: "project",
    ownScopeSwitch: true,
    sections: GO_MODULE_SECTIONS,
    component: GoModulesPage,
  },
  {
    id: "languages.java",
    projectScope: true,
    defaultScope: "project",
    title: "Java",
    group: LANGUAGES_GROUP,
    order: 395,
    keywords: [
      "jdk",
      "project sdk",
      "java home",
      "jdtls",
      "language server jdk",
      "jdk for importer",
      "jvm options",
      "vmargs",
      "lombok",
      "javaagent",
      "eclipse jdt",
      "shared jdtls",
      "linked builds",
      "server process",
    ],
    component: JavaPage,
  },
  {
    id: "languages.node",
    projectScope: true,
    defaultScope: "project",
    title: "JavaScript Runtime",
    group: LANGUAGES_GROUP,
    order: 397,
    keywords: ["node.js", "node interpreter", "package manager", "npm", "pnpm", "yarn", "bun", "deno", "nvm"],
    component: NodePage,
  },
  {
    // Global only, like IDEA's application-level Markdown settings.
    id: "languages.markdown",
    title: "Markdown",
    group: LANGUAGES_GROUP,
    order: 400,
    keywords: ["markdown", "preview", "font size", "jupyter", "notebook"],
    component: MarkdownPage,
  },
  {
    id: "languages.prettier",
    projectScope: true,
    defaultScope: "project",
    title: "Prettier",
    group: LANGUAGES_GROUP,
    order: 403.5,
    keywords: ["formatter", "prettier", "markdown", "yaml", "css", "format on save", "node_modules"],
    component: PrettierPage,
  },
  {
    id: "languages.oxfmt",
    projectScope: true,
    defaultScope: "project",
    title: "oxfmt",
    group: LANGUAGES_GROUP,
    order: 403.6,
    keywords: ["formatter", "oxfmt", "oxc", ".oxfmtrc.json", "format on save", "node_modules"],
    component: OxfmtPage,
  },
  {
    id: "python.docstrings",
    title: "Docstrings",
    group: LANGUAGES_GROUP,
    order: 403.2,
    keywords: [
      "docstrings",
      "docstring format",
      "documentation string format",
      "restructuredtext",
      "epytext",
      "google",
      "numpy",
      "plain",
    ],
    component: DocstringsPage,
  },
  {
    id: "python.ruff",
    projectScope: true,
    defaultScope: "project",
    title: "Ruff",
    group: LANGUAGES_GROUP,
    order: 403.3,
    keywords: [
      "formatter",
      "ruff",
      "python",
      "configuration directory",
      "pyproject.toml",
      "ruff.toml",
      "format on save",
    ],
    component: RuffPage,
  },
  {
    id: "languages.php",
    projectScope: true,
    defaultScope: "project",
    title: "PHP",
    group: LANGUAGES_GROUP,
    order: 403.2,
    keywords: [
      "php interpreter",
      "cli interpreter",
      "language level",
      "php version",
      "xdebug",
      "php",
      "composer",
      "phpunit",
      "phpstan",
      "phpstan.neon",
      "xampp",
      "herd",
      "homebrew",
      "phpbrew",
    ],
    component: PhpPage,
  },
  {
    id: "languages.ruby",
    projectScope: true,
    defaultScope: "project",
    title: "Ruby",
    group: LANGUAGES_GROUP,
    order: 403.8,
    keywords: ["ruby interpreter", "rbenv", "rvm", "chruby", "bundler", "gems", "rake", "rspec"],
    component: RubyPage,
  },
  {
    id: "languages.rust",
    projectScope: true,
    defaultScope: "project",
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
    projectScope: true,
    defaultScope: "project",
    title: "TypeScript",
    group: LANGUAGES_GROUP,
    order: 405,
    keywords: ["typescript version", "tsdk", "tsserver", "node_modules", "vtsls"],
    component: TypeScriptPage,
  },
  {
    id: "languages.zig",
    projectScope: true,
    defaultScope: "project",
    title: "Zig",
    group: LANGUAGES_GROUP,
    order: 406,
    keywords: ["zig toolchain", "zls", "zig build", "build.zig", "build.zig.zon"],
    component: ZigPage,
  },
];
