/**
 * File › New Project… languages and framework starters. One row per language
 * definition in `languages/`, plus an empty project and a web-framework group
 * for each language that has one. `file` is the name `fileIconName` uses when
 * the row has no brand icon.
 */
import type { MenuItem } from "@/ui";
import { fileIconName, type IconName } from "@/ui";
import { executeAction } from "@/platform/actions";

export interface ProjectKind {
  id: string;
  name: string;
  group: string;
  /** Sample file `fileIconName` uses when the kind has no brand icon. */
  file: string | null;
  /** Framework mark. Falls back to the file-type icon. */
  icon?: IconName;
}

interface GroupSpec {
  name: string;
  items: readonly (readonly [id: string, name: string, file: string, icon?: IconName])[];
}

/** Display order. The first group is the ungrouped entry at the top of the list. */
const GROUPS: readonly GroupSpec[] = [
  {
    name: "General",
    items: [
      ["php", "PHP", "index.php", "file-php"],
      ["empty", "Empty Project", ""],
    ],
  },
  {
    name: "PHP specific",
    items: [
      ["laravel", "Laravel", "artisan", "proj-laravel"],
      ["composer-package", "Composer Package Project", "composer.json", "proj-composer"],
      ["drupal", "Drupal Module", "index.php", "proj-drupal"],
      ["joomla", "Joomla! integration", "index.php", "proj-joomla"],
      ["symfony", "Symfony", "index.php", "proj-symfony"],
      ["wordpress-plugin", "WordPress Plugin", "plugin.php", "proj-wordpress"],
      ["cakephp", "CakePHP", "index.php", "proj-cakephp"],
      ["codeigniter", "CodeIgniter", "index.php", "proj-codeigniter"],
      ["laminas", "Laminas", "index.php", "proj-laminas"],
      ["nette", "Nette", "index.php", "proj-nette"],
      ["slim", "Slim", "index.php", "proj-slim"],
      ["wordpress", "WordPress", "functions.php", "proj-wordpress"],
      ["yii", "Yii", "index.php", "proj-yii"],
    ],
  },
  {
    name: "JavaScript",
    items: [
      ["nextjs", "Next.js", "next.config.ts", "proj-next"],
      ["nuxt", "Nuxt.js", "nuxt.config.ts", "proj-nuxt"],
      ["react", "React.js", "App.tsx", "proj-react"],
      ["vuejs", "Vue.js", "App.vue", "file-vue"],
      ["angular", "Angular CLI", "angular.json", "proj-angular"],
      ["sveltekit", "SvelteKit", "svelte.config.js", "proj-svelte"],
      ["astro", "Astro", "astro.config.mjs", "proj-astro"],
      ["remix", "Remix", "vite.config.ts", "proj-remix"],
      ["express", "Express", "index.js", "proj-express"],
      ["nestjs", "NestJS", "nest-cli.json", "proj-nest"],
      ["fastify", "Fastify", "index.js", "proj-fastify"],
      ["vite", "Vite", "vite.config.js", "proj-vite"],
      ["node", "Node.js", "package.json", "proj-node"],
      ["react-native", "React Native", "App.tsx", "proj-react-native"],
      ["bootstrap", "Bootstrap", "index.html", "proj-bootstrap"],
      ["html5-boilerplate", "HTML5 Boilerplate", "index.html", "proj-html5"],
    ],
  },
  {
    name: "Python",
    items: [
      ["django", "Django", "manage.py", "proj-django"],
      ["flask", "Flask", "app.py", "proj-flask"],
      ["fastapi", "FastAPI", "main.py", "proj-fastapi"],
    ],
  },
  {
    name: "Ruby",
    items: [
      ["rails", "Ruby on Rails", "config.ru", "proj-rails"],
      ["sinatra", "Sinatra", "config.ru", "proj-sinatra"],
    ],
  },
  {
    name: "Go",
    items: [
      ["gin", "Gin", "main.go", "proj-gin"],
      ["echo", "Echo", "main.go", "proj-echo"],
      ["fiber", "Fiber", "main.go", "proj-fiber"],
      ["goravel", "Goravel", "main.go", "proj-goravel"],
    ],
  },
  {
    name: "Java",
    items: [["spring", "Spring Boot", "pom.xml", "proj-spring"]],
  },
  {
    name: "Kotlin",
    items: [["ktor", "Ktor", "Application.kt", "proj-ktor"]],
  },
  {
    name: ".NET",
    items: [["aspnet", "ASP.NET Core", "Program.cs", "proj-aspnet"]],
  },
  {
    name: "Rust",
    items: [["axum", "Axum", "Cargo.toml", "proj-axum"]],
  },
  {
    name: "Elixir",
    items: [["phoenix", "Phoenix", "mix.exs", "proj-phoenix"]],
  },
  {
    name: "Dart",
    items: [["flutter", "Flutter", "pubspec.yaml", "proj-flutter"]],
  },
  {
    name: "Scala",
    items: [["play", "Play", "build.sbt", "proj-play"]],
  },
  {
    name: "Swift",
    items: [["vapor", "Vapor", "Package.swift", "proj-vapor"]],
  },
  {
    name: "Clojure",
    items: [["ring", "Ring", "deps.edn", "proj-ring"]],
  },
  {
    name: "Perl",
    items: [["mojolicious", "Mojolicious", "app.pl", "proj-mojo"]],
  },
  {
    name: "Erlang",
    items: [["cowboy", "Cowboy", "rebar.config", "proj-cowboy"]],
  },
  {
    name: "F#",
    items: [["giraffe", "Giraffe", "Program.fs", "proj-giraffe"]],
  },
  {
    name: "Web",
    items: [
      ["css", "CSS", "styles.css"],
      ["html", "HTML", "index.html"],
      ["javascript", "JavaScript", "main.js"],
      ["javascriptreact", "JavaScript JSX", "App.jsx"],
      ["less", "Less", "styles.less"],
      ["sass", "Sass", "styles.sass"],
      ["scss", "SCSS", "styles.scss"],
      ["svelte", "Svelte", "App.svelte"],
      ["typescript", "TypeScript", "main.ts"],
      ["typescriptreact", "TypeScript JSX", "App.tsx"],
      ["vue", "Vue", "App.vue"],
    ],
  },
  {
    name: "JVM",
    items: [
      ["groovy", "Groovy", "Main.groovy"],
      ["java", "Java", "Main.java"],
      ["kotlin", "Kotlin", "Main.kt"],
      ["scala", "Scala", "Main.scala"],
    ],
  },
  {
    name: "Systems",
    items: [
      ["c", "C", "main.c"],
      ["csharp", "C#", "Program.cs"],
      ["cpp", "C++", "main.cpp"],
      ["d", "D", "main.d"],
      ["fsharp", "F#", "Program.fs"],
      ["go", "Go", "main.go"],
      ["go.mod", "Go Module", "go.mod"],
      ["go.work", "Go Workspace", "go.work"],
      ["objective-c", "Objective-C", "main.m"],
      ["objective-cpp", "Objective-C++", "main.mm"],
      ["rust", "Rust", "main.rs"],
      ["swift", "Swift", "main.swift"],
      ["zig", "Zig", "main.zig"],
    ],
  },
  {
    name: "Scripting",
    items: [
      ["bat", "Batch", "build.bat"],
      ["lua", "Lua", "main.lua"],
      ["perl", "Perl", "main.pl"],
      ["powershell", "PowerShell", "main.ps1"],
      ["python", "Python", "main.py"],
      ["r", "R", "main.r"],
      ["ruby", "Ruby", "main.rb"],
      ["shellscript", "Shell Script", "main.sh"],
    ],
  },
  {
    name: "Languages",
    items: [
      ["clojure", "Clojure", "main.clj"],
      ["dart", "Dart", "main.dart"],
      ["elixir", "Elixir", "main.ex"],
      ["erlang", "Erlang", "main.erl"],
      ["gdscript", "GDScript", "main.gd"],
      ["gdshader", "Godot Shader", "main.gdshader"],
      ["haskell", "Haskell", "main.hs"],
      ["julia", "Julia", "main.jl"],
      ["nix", "Nix", "main.nix"],
      ["ocaml", "OCaml", "main.ml"],
      ["ocaml.interface", "OCaml Interface", "main.mli"],
    ],
  },
  {
    name: "Data",
    items: [
      ["graphql", "GraphQL", "schema.graphql"],
      ["ini", "INI", "config.ini"],
      ["json", "JSON", "data.json"],
      ["jsonc", "JSON with Comments", "config.jsonc"],
      ["properties", "Properties", "app.properties"],
      ["proto", "Protocol Buffers", "main.proto"],
      ["sql", "SQL", "query.sql"],
      ["toml", "TOML", "config.toml"],
      ["xml", "XML", "data.xml"],
      ["yaml", "YAML", "data.yaml"],
    ],
  },
  {
    name: "Config",
    items: [
      ["dotenv", ".env", ".env"],
      ["cmake", "CMake", "CMakeLists.txt"],
      ["diff", "Diff", "changes.diff"],
      ["dockerfile", "Dockerfile", "Dockerfile"],
      ["gitattributes", "Git Attributes", ".gitattributes"],
      ["godot-resource", "Godot Resource", "scene.tscn"],
      ["hcl", "HCL", "main.hcl"],
      ["http", "HTTP Request", "api.http"],
      ["ignore", "Ignore File", ".gitignore"],
      ["latex", "LaTeX", "main.tex"],
      ["log", "Log", "app.log"],
      ["makefile", "Makefile", "Makefile"],
      ["markdown", "Markdown", "README.md"],
      ["asciidoc", "AsciiDoc", "README.adoc"],
      ["plaintext", "Plain Text", "notes.txt"],
      ["terraform", "Terraform", "main.tf"],
      ["terraform-vars", "Terraform Variables", "variables.tfvars"],
    ],
  },
];

/** List text when it differs from the language name (`PHP` stays the catalog name). */
const LIST_LABEL: Record<string, string> = { php: "PHP Empty Project" };

export const PROJECT_KINDS: readonly ProjectKind[] = GROUPS.flatMap((group) =>
  group.items.map(([id, name, file, icon]) => ({
    id,
    name,
    group: group.name,
    file: file || null,
    icon,
  })),
);

/** Text shown in the new-project list and menu. */
export function projectKindLabel(kind: ProjectKind): string {
  return LIST_LABEL[kind.id] ?? kind.name;
}

const BY_ID = new Map(PROJECT_KINDS.map((k) => [k.id, k]));

export function projectKind(id: string | null | undefined): ProjectKind {
  return (id && BY_ID.get(id)) || PROJECT_KINDS[0]!;
}

/** Brand icon for a framework, otherwise its file-type icon. */
export function projectKindIcon(kind: ProjectKind): IconName {
  return kind.icon ?? (kind.file ? fileIconName(kind.file) : "folder");
}

export interface ProjectKindGroup {
  name: string;
  kinds: readonly ProjectKind[];
}

export function groupedProjectKinds(): ProjectKindGroup[] {
  const groups: { name: string; kinds: ProjectKind[] }[] = [];
  for (const kind of PROJECT_KINDS) {
    const last = groups[groups.length - 1];
    if (last?.name === kind.group) last.kinds.push(kind);
    else groups.push({ name: kind.group, kinds: [kind] });
  }
  return groups;
}

/** Welcome › New Project chevron: the dialog, then each language group. */
export function newProjectMenuItems(): MenuItem[] {
  return [
    { kind: "action", action: "file.newProject", label: "New Project…", icon: "folder-open" },
    { label: "PHP Empty Project", icon: "file-php", run: () => void executeAction("file.newProject", "php") },
    { label: "Empty Project", icon: "folder", run: () => void executeAction("file.newProject", "empty") },
    { kind: "separator" },
    ...groupedProjectKinds()
      .filter((g) => g.name !== "General")
      .map((g): MenuItem => ({
        label: g.name,
        submenu: g.kinds.map((k) => ({
          label: projectKindLabel(k),
          icon: projectKindIcon(k),
          run: () => void executeAction("file.newProject", k.id),
        })),
      })),
  ];
}
