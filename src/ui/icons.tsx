/**
 * Icon set: JetBrains new-UI ("expui") icons from intellij-community / intellij-plugins
 * (Apache-2.0 / MIT, see THIRD_PARTY_LICENSES.md), vendored as-is under
 * `./expui/<group>/<name>.svg` with their `_dark` and `@20x20` variants. File types
 * whose JetBrains icons are not open source use OpenIDEA's own icons drawn in the same
 * style, under `./openidea/<group>/<name>.svg` (paths prefixed `openidea/`). Names are the
 * contract used by actions (`Action.icon`) and contributions (`ToolWindowContribution.icon`).
 *
 * Rendering: the SVG markup is bundled as raw strings and inlined, so there are no
 * extra requests and icons can be styled.
 * - Monochrome icons (only the standard greys #6C707E light / #CED0D6 dark) are
 *   rewritten to `currentColor` and drawn once. Colour = `var(--icon-color, currentColor)`:
 *   they inherit the caller's text colour (selected / disabled states keep working);
 *   a container can set `--icon-color` to get PyCharm's muted icon grey.
 * - Coloured icons (file types, symbol nodes, run/debug, status…) keep their own
 *   palette; both variants are inlined and CSS shows the one matching `data-theme`
 *   (`light` → light file, anything else → `_dark`).
 * - `size >= 18` picks the `@20x20` variant when one exists (tool window stripes).
 * - Element ids (clip paths) are made unique per instance: WebKit can't resolve
 *   references into `display: none` subtrees, so ids must never be shared.
 */
import { useId, useMemo, type CSSProperties } from "react";
import clsx from "clsx";
import styles from "./icons.module.css";

const RAW = import.meta.glob<string>(["./expui/**/*.svg", "./openidea/**/*.svg"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const ICONS = {
  // Files & folders
  folder: "nodes/folder",
  "folder-open": "nodes/folder",
  "folder-source": "nodes/sourceRoot",
  "folder-test": "nodes/testRoot",
  "folder-resources": "nodes/resourcesRoot",
  "folder-test-resources": "openidea/nodes/testResourcesRoot",
  "folder-excluded": "nodes/excludeRoot",
  "folder-library": "nodes/libraryFolder",
  "folder-github": "nodes/folderGithub",
  module: "nodes/module",
  "spring-boot": "openidea/runConfigurations/springBoot",
  file: "fileTypes/text",
  "file-unknown": "fileTypes/unknown",
  "file-code": "fileTypes/anyType",
  "file-text": "fileTypes/text",
  "file-json": "fileTypes/json",
  "file-md": "fileTypes/markdown",
  "file-image": "fileTypes/image",
  "file-config": "fileTypes/config",
  "file-python": "fileTypes/python",
  "file-jupyter": "fileTypes/jupyter",
  "file-requirements": "fileTypes/requirements",
  "file-pipenv": "fileTypes/pipenv",
  "file-pyproject": "fileTypes/pyprojectToml",
  "file-js": "fileTypes/javaScript",
  "file-jsx": "openidea/fileTypes/jsx",
  "file-ts": "fileTypes/typeScript",
  "file-tsx": "openidea/fileTypes/tsx",
  "file-npm": "openidea/fileTypes/npm",
  "file-vue": "fileTypes/vue",
  "file-svelte": "openidea/fileTypes/svelte",
  "file-yaml": "fileTypes/yaml",
  "file-toml": "fileTypes/toml",
  "file-html": "fileTypes/html",
  "file-xhtml": "fileTypes/xhtml",
  "file-css": "fileTypes/css",
  "file-less": "openidea/fileTypes/less",
  "file-sass": "openidea/fileTypes/sass",
  "file-scss": "openidea/fileTypes/scss",
  "file-xml": "fileTypes/xml",
  "file-xsd": "fileTypes/xsd",
  "file-shell": "fileTypes/shell",
  "file-powershell": "openidea/fileTypes/powershell",
  "file-windows": "fileTypes/microsoftWindows",
  "file-sql": "fileTypes/sql",
  "file-graphql": "fileTypes/graphql",
  "file-proto": "fileTypes/protoFile",
  "file-csv": "fileTypes/csv",
  "file-properties": "fileTypes/properties",
  "file-ignored": "fileTypes/ignored",
  "file-git": "fileTypes/gitignore",
  "file-archive": "fileTypes/archive",
  "file-binary": "fileTypes/binaryData",
  "file-font": "fileTypes/font",
  "file-patch": "fileTypes/patch",
  "file-java": "fileTypes/java",
  "file-kotlin": "fileTypes/kotlin",
  "file-kotlin-script": "fileTypes/kotlinScript",
  "file-groovy": "fileTypes/groovy",
  "file-gradle": "fileTypes/gradle",
  "file-gradle-kts": "fileTypes/kotlinGradleScript",
  "file-maven": "fileTypes/maven",
  "file-scala": "language/scala",
  "file-php": "language/php",
  "file-perl": "fileTypes/perl",
  "file-c": "fileTypes/c",
  "file-cpp": "fileTypes/cpp",
  "file-h": "fileTypes/h",
  "file-objc": "openidea/fileTypes/objectiveC",
  "file-objcpp": "openidea/fileTypes/objectiveCpp",
  "file-csharp": "fileTypes/Csharp",
  "file-fsharp": "openidea/fileTypes/fsharp",
  "file-swift": "fileTypes/swiftLang",
  "file-go": "openidea/fileTypes/go",
  "file-gomod": "openidea/fileTypes/goMod",
  "file-gowork": "openidea/fileTypes/goWork",
  "file-rust": "openidea/fileTypes/rust",
  "file-cargo": "openidea/fileTypes/cargo",
  "file-ruby": "openidea/fileTypes/ruby",
  "file-lua": "openidea/fileTypes/lua",
  "file-zig": "openidea/fileTypes/zig",
  "file-gdscript": "openidea/fileTypes/gdscript",
  "file-godot": "openidea/fileTypes/godot",
  "file-gdshader": "openidea/fileTypes/gdshader",
  "file-dart": "openidea/fileTypes/dart",
  "file-elixir": "openidea/fileTypes/elixir",
  "file-erlang": "openidea/fileTypes/erlang",
  "file-haskell": "openidea/fileTypes/haskell",
  "file-ocaml": "openidea/fileTypes/ocaml",
  "file-clojure": "openidea/fileTypes/clojure",
  "file-julia": "openidea/fileTypes/julia",
  "file-r": "openidea/fileTypes/r",
  "file-nix": "openidea/fileTypes/nix",
  "file-latex": "openidea/fileTypes/latex",
  "file-rst": "fileTypes/rst",
  "file-docker": "fileTypes/docker",
  "file-makefile": "fileTypes/makefile",
  "file-cmake": "openidea/fileTypes/cmake",
  "file-bazel": "fileTypes/bazel",
  "file-jenkins": "fileTypes/jenkins",
  "file-terraform": "fileTypes/terraform",
  "file-hcl": "fileTypes/hashiCorp",
  "file-dotenv": "openidea/fileTypes/dotenv",
  "file-lock": "openidea/fileTypes/lock",
  "file-license": "openidea/fileTypes/license",
  "file-readme": "openidea/fileTypes/readme",
  "file-log": "openidea/fileTypes/log",
  "file-http": "fileTypes/http",
  "file-regexp": "fileTypes/regexp",
  "file-manifest": "fileTypes/manifest",
  "file-idl": "fileTypes/idl",
  // Tool windows (each one distinct)
  "toolwindow-project": "toolwindows/project",
  "toolwindow-structure": "toolwindows/structure",
  "toolwindow-hierarchy": "toolwindows/hierarchy",
  "toolwindow-find": "toolwindows/find",
  "toolwindow-usages": "actions/findEntireFile",
  "toolwindow-bookmarks": "toolwindows/bookmarks",
  "toolwindow-commit": "toolwindows/commit",
  "toolwindow-git": "toolwindows/vcs",
  "toolwindow-terminal": "toolwindows/terminal",
  "toolwindow-run": "toolwindows/run",
  "toolwindow-debug": "toolwindows/debug",
  "toolwindow-problems": "toolwindows/problems",
  "toolwindow-todo": "toolwindows/todo",
  "toolwindow-notifications": "toolwindows/notifications",
  "toolwindow-services": "toolwindows/services",
  "toolwindow-pull-requests": "toolwindows/pullRequests",
  "toolwindow-inspection": "toolwindows/toolWindowInspection",
  "toolwindow-duplicates": "toolwindows/toolWindowDuplicates",
  "toolwindow-changes": "toolwindows/changes",
  "toolwindow-database": "openidea/toolwindows/database",
  "toolwindow-agents": "openidea/toolwindows/agents",
  // Coding agents (logos via Paseo)
  "agent-claude": "openidea/agents/claude",
  "agent-codex": "openidea/agents/codex",
  "agent-gemini": "openidea/agents/gemini",
  "agent-copilot": "openidea/agents/copilot",
  "agent-cursor": "openidea/agents/cursor",
  "agent-opencode": "openidea/agents/opencode",
  "agent-qwen": "openidea/agents/qwen",
  "agent-kimi": "openidea/agents/kimi",
  "agent-goose": "openidea/agents/goose",
  "agent-auggie": "openidea/agents/auggie",
  "agent-kiro": "openidea/agents/kiro",
  "agent-vibe": "openidea/agents/vibe",
  "toolwindow-maven": "toolwindows/maven",
  "toolwindow-gradle": "toolwindows/gradle",
  "toolwindow-build": "toolwindows/build",
  // General UI
  "chevron-right": "general/chevronRight",
  "chevron-down": "general/chevronDown",
  "chevron-up": "general/chevronUp",
  "chevron-left": "general/chevronLeft",
  close: "general/close",
  plus: "general/add",
  minus: "general/remove",
  check: "actions/checked",
  more: "general/moreVertical",
  "more-horizontal": "general/moreHorizontal",
  search: "general/search",
  replace: "actions/replace",
  regex: "inline/regex",
  case: "inline/matchCase",
  word: "inline/exactWords",
  "text-match": "openidea/nodes/textMatch",
  "open-in-tool-window": "general/openInToolWindow",
  "preserve-case": "openidea/inline/preserveCase",
  "new-line": "openidea/inline/newLine",
  "search-history": "openidea/inline/searchHistory",
  filter: "general/filter",
  refresh: "general/refresh",
  settings: "general/settings",
  layout: "general/layout",
  split: "general/splitVertically",
  "split-horizontal": "general/splitHorizontally",
  maximize: "image/fitContent",
  "zoom-in": "openidea/general/zoomIn",
  "zoom-out": "openidea/general/zoomOut",
  "actual-size": "openidea/general/actualZoom",
  chessboard: "openidea/general/chessboard",
  minimize: "general/openInToolWindow",
  "main-menu": "openidea/general/mainMenu",
  "window-minimize": "openidea/general/windowMinimize",
  "window-maximize": "openidea/general/windowMaximize",
  "window-restore": "openidea/general/windowRestore",
  "window-close": "openidea/general/windowClose",
  hide: "general/hide",
  pin: "general/pin",
  eye: "general/show",
  lock: "general/locked",
  unlock: "openidea/general/unlocked",
  scratches: "fileTypes/scratches",
  "external-link": "ide/externalLink",
  "collapse-all": "general/collapseAll",
  "expand-all": "general/expandAll",
  locate: "general/locate",
  "autoscroll-to-source": "general/autoscrollToSource",
  "autoscroll-from-source": "general/autoscrollFromSource",
  sort: "objectBrowser/sortAlphabetically",
  copy: "general/copy",
  paste: "general/paste",
  cut: "general/cut",
  trash: "general/delete",
  edit: "general/edit",
  "arrow-left": "general/left",
  "arrow-right": "general/right",
  "arrow-up": "general/up",
  "arrow-down": "general/down",
  undo: "general/undo",
  redo: "general/redo",
  sun: "meetNewUi/lightTheme",
  moon: "meetNewUi/darkTheme",
  list: "general/listFiles",
  keyboard: "general/keyboard",
  bulb: "codeInsight/intentionBulb",
  "bulb-fix": "codeInsight/quickfixBulb",
  package: "nodes/package",
  plugin: "nodes/plugin",
  "soft-wrap": "general/softWrap",
  history: "general/history",
  clock: "general/history",
  bell: "toolwindows/notifications",
  database: "nodes/dataTables",
  "db-table": "openidea/database/table",
  "db-view": "openidea/database/view",
  "db-column": "openidea/database/column",
  "db-columns": "openidea/database/columns",
  "db-column-key": "openidea/database/columnKey",
  "db-column-fk": "openidea/database/columnForeignKey",
  "db-key": "openidea/database/key",
  "db-foreign-key": "openidea/database/foreignKey",
  "db-index": "openidea/database/index",
  "db-schema": "openidea/database/schema",
  "db-console": "openidea/database/console",
  "db-matview": "openidea/database/matview",
  "db-routine": "openidea/database/routine",
  "db-trigger": "openidea/database/trigger",
  "db-sequence": "openidea/database/sequence",
  "db-plan": "openidea/database/plan",
  "db-chart": "openidea/database/chart",
  "db-sort": "openidea/database/sort",
  "db-folder": "openidea/database/folder",
  "db-add": "openidea/database/addDropdown",
  "db-properties": "openidea/database/dataSourceProperties",
  "db-disconnect": "openidea/database/disconnect",
  "db-sqlite": "openidea/database/sqlite",
  "db-postgres": "openidea/database/postgres",
  "db-mysql": "openidea/database/mysql",
  "db-sqlserver": "openidea/database/sqlserver",
  "db-mariadb": "openidea/database/mariadb",
  "db-aurora": "openidea/database/aurora",
  "db-redshift": "openidea/database/redshift",
  "db-cockroach": "openidea/database/cockroach",
  "db-greenplum": "openidea/database/greenplum",
  "db-neon": "openidea/database/neon",
  "db-oceanbase": "openidea/database/oceanbase",
  "db-singlestore": "openidea/database/singlestore",
  "db-supabase": "openidea/database/supabase",
  "db-tidb": "openidea/database/tidb",
  "db-timescale": "openidea/database/timescale",
  "db-yugabyte": "openidea/database/yugabyte",
  export: "openidea/general/export",
  web: "openidea/general/web",
  "browser-chrome": "openidea/browsers/chrome",
  "browser-chromium": "openidea/browsers/chromium",
  "browser-firefox": "openidea/browsers/firefox",
  "browser-safari": "openidea/browsers/safari",
  "browser-edge": "openidea/browsers/edge",
  "browser-brave": "openidea/browsers/brave",
  // Tool-window-ish glyphs kept for actions and older callers
  structure: "toolwindows/structure",
  hierarchy: "toolwindows/hierarchy",
  terminal: "toolwindows/terminal",
  problems: "toolwindows/problems",
  todo: "toolwindows/todo",
  bookmark: "bookmarks/bookmark",
  // Status
  error: "status/error",
  warning: "status/warning",
  info: "status/info",
  success: "status/success",
  // Run / debug
  run: "run/run",
  debug: "run/debug",
  "run-coverage": "run/runWithCoverage",
  profile: "run/profile",
  "toolwindow-coverage": "toolwindows/coverage",
  "toolwindow-profiler": "toolwindows/profiler",
  "gutter-run": "gutter/run",
  "gutter-run-all": "actions/runAll",
  "gutter-run-passed": "gutter/runSuccess",
  "gutter-run-failed": "gutter/runError",
  "gutter-implemented": "gutter/implementedMethod",
  "gutter-implementing": "gutter/implementingMethod",
  "gutter-overridden": "gutter/overridenMethod",
  "gutter-overriding": "gutter/overridingMethod",
  stop: "run/stop",
  rerun: "run/rerun",
  "rerun-filled": "run/rerun_stroke",
  "restart-debug": "run/restartDebug",
  "restart-debug-filled": "run/restartDebug_stroke",
  "stop-filled": "run/stop_stroke",
  resume: "run/resume",
  pause: "run/pause",
  "step-over": "run/stepOver",
  "step-into": "run/stepInto",
  "step-out": "run/stepOut",
  "run-to-cursor": "run/runToCursor",
  "force-run-to-cursor": "run/forceRunToCursor",
  "force-step-into": "run/forceStepInto",
  "force-step-over": "run/forceStepOver",
  "smart-step-into": "run/smartStepInto",
  "show-execution-point": "run/showCurrentFrame",
  "reset-frame": "run/restartFrame",
  "attach-to-process": "run/attachToProcess",
  "evaluate-expression": "run/evaluateExpression",
  breakpoint: "breakpoints/breakpoint",
  "breakpoint-disabled": "breakpoints/breakpointDisabled",
  "breakpoint-muted": "breakpoints/breakpointMuted",
  "breakpoint-method": "breakpoints/breakpointMethod",
  "breakpoint-field": "breakpoints/breakpointField",
  "breakpoint-exception": "breakpoints/breakpointException",
  "mute-breakpoint": "run/muteBreakpoints",
  "view-breakpoints": "run/viewBreakpoints",
  // Build tools (Maven / Gradle tool windows)
  "maven-project": "maven/mavenProject",
  "maven-module": "maven/mavenModule",
  "maven-goal": "maven/mavenGoal",
  "maven-plugin": "maven/mavenPlugin",
  "maven-plugin-goal": "maven/mavenPluginGoal",
  "maven-profiles": "maven/mavenProfiles",
  "maven-load-changes": "maven/mavenLoadChanges",
  "gradle-load-changes": "build/gradleLoadChanges",
  "build-task": "externalSystem/task",
  "build-task-group": "build/taskGroup",
  "build-offline": "build/toggleOfflineMode",
  "build-dependencies": "build/dependencyAnalyzer",
  // Build menu (Build Project / Rebuild Project)
  "build-project": "build/build",
  "build-rebuild": "build/rebuild",
  "skip-tests": "run/showIgnored",
  "run-anything": "general/runAnything",
  library: "nodes/library",
  // VCS
  commit: "vcs/commit",
  branch: "general/vcs",
  "git-pull": "vcs/update",
  "git-push": "vcs/push",
  "git-fetch": "vcs/fetch",
  // Branch widget incoming / outgoing markers (dvcs-impl `icons/new`).
  "vcs-incoming": "vcs/changesUpdate@12x12",
  "vcs-outgoing": "vcs/changesPush@12x12",
  diff: "vcs/diff",
  revert: "vcs/revert",
  shelve: "vcs/shelve",
  unshelve: "vcs/unshelve",
  changelist: "vcs/changelist",
  stash: "openidea/vcs/stash",
  star: "openidea/vcs/favorite",
  "star-outline": "openidea/vcs/notFavorite",
  tag: "openidea/vcs/tag",
  "current-branch": "openidea/vcs/currentBranch",
  // Symbols (also used by `symbol-<kind>`)
  class: "nodes/class",
  interface: "nodes/interface",
  enum: "nodes/enum",
  method: "nodes/method",
  function: "nodes/function",
  field: "nodes/field",
  variable: "nodes/variable",
} as const satisfies Record<string, string>;

type BaseName = keyof typeof ICONS;

// ---------------------------------------------------------------------------
// IDEA symbol kinds. Kinds with an expui node icon render it; the rest fall back
// to a letter badge ("k" for keywords…).

export type SymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "struct"
  | "trait"
  | "method"
  | "function"
  | "constructor"
  | "field"
  | "property"
  | "variable"
  | "constant"
  | "parameter"
  | "module"
  | "namespace"
  | "package"
  | "type"
  | "annotation"
  | "keyword"
  | "snippet"
  | "file"
  | "text";

const SYMBOL_ICONS: Partial<Record<SymbolKind, string>> = {
  class: "nodes/class",
  interface: "nodes/interface",
  enum: "nodes/enum",
  struct: "nodes/record",
  trait: "nodes/interface",
  method: "nodes/method",
  function: "nodes/function",
  constructor: "nodes/constructor",
  field: "nodes/field",
  property: "nodes/property",
  variable: "nodes/variable",
  constant: "nodes/constant",
  parameter: "nodes/parameter",
  module: "nodes/module",
  namespace: "nodes/package",
  package: "nodes/package",
  type: "nodes/type",
  annotation: "nodes/annotation",
  snippet: "nodes/template",
  file: "fileTypes/text",
  text: "fileTypes/text",
};

export type IconName = BaseName | `symbol-${SymbolKind}`;

export const ICON_NAMES = Object.keys(ICONS) as BaseName[];

function iconPath(name: string): string | undefined {
  if (name.startsWith("symbol-")) return SYMBOL_ICONS[name.slice(7) as SymbolKind];
  return (ICONS as Record<string, string>)[name];
}

// ---------------------------------------------------------------------------
// SVG processing

const MONO_LIGHT = "#6c707e";
const MONO_DARK = "#ced0d6";
const COLOR_RE = /#[0-9a-f]{3,8}\b/gi;

interface Variant {
  viewBox: string;
  body: string;
}

interface Prepared {
  viewBox: string;
  /** Markup; element ids carry an `__ID__` placeholder prefix when `hasIds`. */
  html: string;
  hasIds: boolean;
  mono: boolean;
}

function raw(path: string): string | undefined {
  return RAW[path.startsWith("openidea/") ? `./${path}.svg` : `./expui/${path}.svg`];
}

function parse(svg: string): Variant {
  const open = svg.indexOf("<svg");
  const start = svg.indexOf(">", open) + 1;
  const end = svg.lastIndexOf("</svg>");
  const tag = svg.slice(open, start);
  const w = /\bwidth="([\d.]+)"/.exec(tag)?.[1] ?? "16";
  const h = /\bheight="([\d.]+)"/.exec(tag)?.[1] ?? w;
  const viewBox = /\bviewBox="([^"]+)"/.exec(tag)?.[1] ?? `0 0 ${w} ${h}`;
  const body = svg
    .slice(start, end)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(title|metadata)\b[\s\S]*?<\/\1>/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\bid="([^"]+)"/g, 'id="__ID__$1"')
    .replace(/url\(#([^)]+)\)/g, "url(#__ID__$1)")
    .replace(/href="#([^"]+)"/g, 'href="#__ID__$1"')
    .trim();
  return { viewBox, body };
}

const colours = (s: string) => new Set((s.match(COLOR_RE) ?? []).map((c) => c.toLowerCase()));
const only = (set: Set<string>, c: string) => set.size > 0 && [...set].every((x) => x === c);

const prepared = new Map<string, Prepared | null>();

function build(lightSrc: string, darkSrc: string | undefined, keepColours: boolean): Omit<Prepared, "hasIds"> {
  const light = parse(lightSrc);
  const dark = darkSrc ? parse(darkSrc) : undefined;
  const viewBox = light.viewBox;
  if (!keepColours && only(colours(light.body), MONO_LIGHT) && (!dark || only(colours(dark.body), MONO_DARK))) {
    return { viewBox, html: light.body.replace(COLOR_RE, "currentColor"), mono: true };
  }
  if (!dark) return { viewBox, html: light.body, mono: false };
  const html =
    `<g class="${styles.light}">${light.body.replace(/__ID__/g, "__ID__l")}</g>` +
    `<g class="${styles.dark}">${dark.body.replace(/__ID__/g, "__ID__d")}</g>`;
  return { viewBox, html, mono: false };
}

function prepare(path: string, large: boolean): Prepared | null {
  const key = `${path}|${large ? 20 : 16}`;
  let out = prepared.get(key);
  if (out !== undefined) return out;
  const base = large && raw(`${path}@20x20`) ? `${path}@20x20` : path;
  const lightSrc = raw(base);
  out = null;
  if (lightSrc) {
    const b = build(lightSrc, raw(`${base}_dark`), path.startsWith("breakpoints/"));
    out = { ...b, hasIds: b.html.includes("__ID__") };
  }
  prepared.set(key, out);
  return out;
}

const EMPTY: Prepared = { viewBox: "0 0 16 16", html: "", hasIds: false, mono: true };

const withIds = (p: Prepared, prefix: string) => (p.hasIds ? p.html.replace(/__ID__/g, prefix) : p.html);

// ---------------------------------------------------------------------------

export interface IconProps {
  /** Icon name; unknown names render the generic file icon. `symbol-<kind>` renders a symbol node icon. */
  name: IconName | (string & {});
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Accessible label; icons are decorative (aria-hidden) without one. */
  label?: string;
}

export function Icon({ name, size = 16, className, style, label }: IconProps) {
  const uid = useId();
  const path = iconPath(name);
  const p = (path && prepare(path, size >= 18)) || prepare(ICONS.file, size >= 18) || EMPTY;
  const html = useMemo(() => withIds(p, `i${uid.replace(/[^a-zA-Z0-9_-]/g, "")}-`), [p, uid]);
  if (!path && name.startsWith("symbol-")) {
    return <SymbolBadge kind={name.slice(7)} className={className} style={style} />;
  }
  return (
    <svg
      className={clsx(styles.icon, p.mono && styles.mono, className)}
      style={style}
      width={size}
      height={size}
      viewBox={p.viewBox}
      fill="none"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

let markupSeq = 0;

/** SVG markup for non-React (CodeMirror DOM) callers; `null` when the name is unknown. */
export function iconMarkup(name: string, size = 16, className?: string): string | null {
  const path = iconPath(name);
  const p = path && prepare(path, size >= 18);
  if (!p) return null;
  const cls = clsx(styles.icon, p.mono && styles.mono, className);
  const html = withIds(p, `m${++markupSeq}-`);
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="${p.viewBox}" fill="none" aria-hidden="true" focusable="false">${html}</svg>`;
}

/**
 * Like `iconMarkup`, but never `null`: what `<Icon>` renders for unknown names
 * (a symbol letter badge, else the generic file icon). Plain strings, so
 * CodeMirror callers need no React renderer.
 */
export function iconMarkupOrFallback(name: string, size = 16): string {
  const html = iconMarkup(name, size);
  if (html !== null) return html;
  if (name.startsWith("symbol-")) {
    const kind = name.slice(7).replace(/[^\w-]/g, "");
    const letter = symbolLetter(kind).replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<span class="${styles.symbol}" data-kind="${kind}" aria-hidden="true">${letter}</span>`;
  }
  return iconMarkup("file", size) ?? "";
}

export function hasIcon(name: string): boolean {
  return iconPath(name) !== undefined || name.startsWith("symbol-");
}

// ---------------------------------------------------------------------------
// Symbol kind badges

const SYMBOL_LETTERS: Record<SymbolKind, string> = {
  class: "C",
  interface: "I",
  enum: "E",
  struct: "S",
  trait: "T",
  method: "m",
  function: "ƒ",
  constructor: "c",
  field: "f",
  property: "p",
  variable: "v",
  constant: "K",
  parameter: "a",
  module: "M",
  namespace: "N",
  package: "P",
  type: "T",
  annotation: "@",
  keyword: "k",
  snippet: "~",
  file: "F",
  text: "t",
};

export function symbolLetter(kind: string): string {
  return SYMBOL_LETTERS[kind as SymbolKind] ?? kind.charAt(0) ?? "?";
}

/** Symbol kind icon (expui `nodes/*`), or a letter badge for kinds without one. */
export function SymbolBadge({
  kind,
  size = 16,
  className,
  style,
}: {
  kind: SymbolKind | (string & {});
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  if (SYMBOL_ICONS[kind as SymbolKind]) {
    return <Icon name={`symbol-${kind}`} size={size} className={className} style={style} />;
  }
  return (
    <span className={clsx(styles.symbol, className)} style={style} data-kind={kind} aria-hidden>
      {symbolLetter(kind)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// File type icons — the one place that maps file names to icons (project tree,
// editor tabs, Search Everywhere, recent files, VCS trees…). Lookup order: exact
// file name, name patterns, two-part extension (`gradle.kts`), extension.

/** `icon: "a b c"` → `{ a: icon, b: icon, c: icon }`. */
function table(groups: Partial<Record<IconName, string>>): Record<string, IconName> {
  const out: Record<string, IconName> = {};
  for (const [icon, keys] of Object.entries(groups) as [IconName, string][]) {
    for (const key of keys.split(/\s+/)) if (key) out[key] = icon;
  }
  return out;
}

/** Lower-case file names. */
const FILE_NAMES = table({
  "file-docker": "dockerfile containerfile",
  "file-makefile": "makefile gnumakefile bsdmakefile makefile.am makefile.in kbuild",
  "file-cmake": "cmakelists.txt cmakecache.txt",
  "file-perl": "makefile.pl build.pl cpanfile",
  "file-git": ".gitignore .gitignore_global .gitattributes .gitmodules .gitconfig .git-blame-ignore-revs .mailmap",
  "file-ignored":
    ".dockerignore .npmignore .prettierignore .eslintignore .stylelintignore .hgignore .ignore .rgignore " +
    ".fdignore .helmignore .vscodeignore .gcloudignore .slugignore .cfignore .bzrignore .containerignore",
  "file-config":
    ".editorconfig justfile procfile .npmrc .nvmrc .yarnrc .node-version .python-version .ruby-version " +
    ".tool-versions .browserslistrc .pypirc .flake8 .pylintrc pylintrc setup.cfg tox.ini pytest.ini mypy.ini " +
    ".coveragerc .hgrc hgrc credentials .jshintrc .gemrc .clang-format .clang-tidy .clangd .watchmanconfig .arcconfig",
  "file-npm": "package.json",
  "file-lock":
    "package-lock.json npm-shrinkwrap.json pnpm-lock.yaml bun.lockb deno.lock go.sum go.work.sum " + "package.resolved",
  "file-cargo": "cargo.toml",
  "file-gomod": "go.mod",
  "file-gowork": "go.work",
  "file-pyproject": "pyproject.toml",
  "file-pipenv": "pipfile",
  "file-python": "sconstruct sconscript",
  "file-ruby":
    "gemfile rakefile podfile vagrantfile brewfile guardfile fastfile appfile capfile dangerfile steepfile " +
    ".irbrc .pryrc",
  "file-shell":
    ".bashrc .bash_profile .bash_login .bash_logout .bash_aliases .profile .zshrc .zshenv .zprofile .zlogin " +
    ".zlogout .kshrc pkgbuild apkbuild .envrc",
  "file-dotenv": ".flaskenv",
  "file-gradle": "gradlew",
  "file-maven": "pom.xml mvnw",
  "file-jenkins": "jenkinsfile",
  "file-bazel": "build workspace .bazelrc .bazelversion",
  "file-terraform": ".terraformrc terraform.rc",
  "file-clojure": "deps.edn project.clj bb.edn",
  "file-erlang": "rebar.config sys.config",
  "file-r": ".rprofile",
  "file-lua": ".luacheckrc",
  "file-yaml": "citation.cff",
  "file-manifest": "manifest.mf",
  "file-readme": "readme readme.txt",
  "file-text": "authors notice codeowners contributors changelog",
});

/** Name patterns, tried in order (lower-case names). */
const NAME_PATTERNS: readonly (readonly [RegExp, IconName])[] = [
  [/^(dockerfile|containerfile)[.-]/, "file-docker"],
  [/^(docker-)?compose([.-][\w-]+)?\.ya?ml$/, "file-docker"],
  [/^\.env(\.|$)/, "file-dotenv"],
  [/^(licen[cs]e|copying)(-[\w.-]+|\.(md|txt|rst))?$/, "file-license"],
  [/^requirements([.-][\w.-]*)?\.(txt|in)$/, "file-requirements"],
  [/^(ts|js)config(\.[\w-]+)?\.json$/, "file-config"],
  [/\.config\.[cm]?[jt]s$/, "file-config"],
  [/^\.(eslintrc|prettierrc|stylelintrc|babelrc|swcrc|lintstagedrc|commitlintrc|markdownlintrc)(\.|$)/, "file-config"],
];

/** Lower-case extensions, including two-part ones (`gradle.kts`). */
const EXT_ICONS = table({
  "file-python": "py pyi pyw pyx pxd",
  "file-jupyter": "ipynb",
  "file-js": "js mjs cjs",
  "file-jsx": "jsx",
  "file-ts": "ts mts cts",
  "file-tsx": "tsx",
  "file-vue": "vue",
  "file-svelte": "svelte",
  "file-json": "json jsonc json5 jsonl ndjson geojson topojson webmanifest har avsc code-workspace code-snippets map",
  "file-md": "md mdx markdown mdown mkd mkdn mdwn ronn workbook",
  "file-rst": "rst",
  "file-yaml": "yaml yml",
  "file-toml": "toml",
  "file-text": "txt text adoc",
  "file-log": "log",
  "file-csv": "csv tsv",
  "file-html": "html htm shtml html.tmpl",
  "file-xhtml": "xhtml",
  "file-css": "css pcss postcss",
  "file-less": "less",
  "file-sass": "sass",
  "file-scss": "scss",
  "file-xml":
    "xml xsl xslt plist csproj fsproj vbproj props targets nuspec xaml axaml resx wsdl fxml iml jnlp rss atom " +
    "xliff xlf storyboard xib tld pom",
  "file-xsd": "xsd",
  "file-shell": "sh bash zsh ksh ash dash bats fish command",
  "file-powershell": "ps1 psm1 psd1 pssc psrc",
  "file-windows": "bat cmd exe",
  "file-sql": "sql ddl dml psql pgsql mysql",
  "file-graphql": "graphql graphqls gql",
  "file-proto": "proto",
  "file-image": "png jpg jpeg gif svg webp ico icns bmp tif tiff avif",
  "file-archive": "zip tar gz tgz bz2 xz zst 7z rar jar war whl egg",
  "file-config": "ini cfg conf cnf inf reg url desktop service socket timer config",
  "file-dotenv": "env",
  "file-lock": "lock lockb",
  "file-git": "gitignore",
  "file-ignored": "dockerignore",
  "file-properties": "properties prefs",
  "file-font": "ttf otf woff woff2",
  "file-patch": "patch diff rej",
  "file-java": "java",
  "file-kotlin": "kt",
  "file-kotlin-script": "kts",
  "file-groovy": "groovy gvy gy gsh",
  "file-gradle": "gradle",
  "file-gradle-kts": "gradle.kts",
  "file-scala": "scala sc sbt mill",
  "file-php": "php phtml php3 php4 php5 phps phpt",
  "file-perl": "pl pm pod psgi cgi",
  "file-c": "c",
  "file-h": "h hpp hh hxx h++",
  "file-cpp": "cpp cc cxx c++ ipp tpp inl ixx cppm",
  "file-objc": "m",
  "file-objcpp": "mm",
  "file-csharp": "cs csx",
  "file-fsharp": "fs fsi fsx",
  "file-swift": "swift swiftinterface",
  "file-go": "go",
  "file-rust": "rs",
  "file-ruby": "rb rake gemspec ru rbi jbuilder podspec",
  "file-lua": "lua luau rockspec",
  "file-zig": "zig zon",
  "file-gdscript": "gd",
  "file-godot": "tscn tres godot import",
  "file-gdshader": "gdshader gdshaderinc",
  "file-dart": "dart",
  "file-elixir": "ex exs",
  "file-erlang": "erl hrl escript app.src",
  "file-haskell": "hs lhs hs-boot hsig",
  "file-ocaml": "ml mli mll mly",
  "file-clojure": "clj cljs cljc cljd edn bb",
  "file-julia": "jl",
  "file-r": "r rprofile",
  "file-nix": "nix",
  "file-latex": "tex ltx sty cls dtx ins bbx cbx bib",
  "file-docker": "dockerfile containerfile",
  "file-makefile": "mk mak make",
  "file-cmake": "cmake",
  "file-bazel": "bazel bzl",
  "file-terraform": "tf tofu tfvars tftest.hcl",
  "file-hcl": "hcl nomad pkr.hcl",
  "file-http": "http rest",
  "file-regexp": "regexp",
  "file-idl": "idl",
  "file-binary": "class bin dat so dylib dll o a wasm pyc",
});

/** Source files for languages without a file-type icon. */
const CODE_EXT = new Set(["astro", "nim", "wit", "wat", "sol", "v", "sv"]);

let iconOverride: ((fileName: string) => IconName | null) | null = null;

/** Lets the user's file type associations (Settings › File Types) pick icons first. */
export function setFileIconOverride(resolve: ((fileName: string) => IconName | null) | null) {
  iconOverride = resolve;
}

/** Picks a file-type icon from a file name. */
export function fileIconName(fileName: string): IconName {
  const custom = iconOverride?.(fileName);
  if (custom) return custom;
  const lower = fileName.toLowerCase();
  const named = FILE_NAMES[lower] ?? NAME_PATTERNS.find(([re]) => re.test(lower))?.[1];
  if (named) return named;
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return "file-text";
  const ext = lower.slice(dot + 1);
  const prev = lower.lastIndexOf(".", dot - 1);
  const ext2 = prev > 0 ? lower.slice(prev + 1) : undefined;
  const icon = (ext2 && EXT_ICONS[ext2]) || EXT_ICONS[ext];
  if (icon) return icon;
  if (CODE_EXT.has(ext)) return "file-code";
  return "file-unknown";
}

export type FolderKind =
  | "plain"
  | "source"
  | "test"
  | "resources"
  | "testResources"
  | "excluded"
  | "library"
  | "github"
  | "module";

/** Folder icon by role (expui has no separate "open" folder glyph). */
export function folderIconName(kind: FolderKind = "plain"): IconName {
  switch (kind) {
    case "source":
      return "folder-source";
    case "test":
      return "folder-test";
    case "resources":
      return "folder-resources";
    case "testResources":
      return "folder-test-resources";
    case "excluded":
      return "folder-excluded";
    case "library":
      return "folder-library";
    case "github":
      return "folder-github";
    case "module":
      return "module";
    default:
      return "folder";
  }
}
