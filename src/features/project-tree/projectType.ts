/** Project identity comes from manifests, never from the folder's name or installed tools. */
import type { IconName } from "@/ui/icons";

export const PROJECT_TYPES = {
  quarkus: { name: "Quarkus", icon: "project-quarkus" },
  spring: { name: "Spring Boot", icon: "spring-boot" },
  ktor: { name: "Ktor", icon: "project-ktor" },
  compose: { name: "Compose Multiplatform", icon: "project-compose" },
  kmp: { name: "Kotlin Multiplatform", icon: "file-kotlin" },
  android: { name: "Android", icon: "project-android" },
  flutter: { name: "Flutter", icon: "project-flutter" },
  next: { name: "Next.js", icon: "project-nextjs" },
  nuxt: { name: "Nuxt", icon: "project-nuxt" },
  sveltekit: { name: "SvelteKit", icon: "project-svelte" },
  angular: { name: "Angular", icon: "project-angular" },
  nest: { name: "NestJS", icon: "project-nestjs" },
  astro: { name: "Astro", icon: "file-astro" },
  svelte: { name: "Svelte", icon: "project-svelte" },
  vue: { name: "Vue", icon: "file-vue" },
  react: { name: "React", icon: "project-react" },
  express: { name: "Express", icon: "project-express" },
  fastapi: { name: "FastAPI", icon: "project-fastapi" },
  django: { name: "Django", icon: "project-django" },
  flask: { name: "Flask", icon: "project-flask" },
  laravel: { name: "Laravel", icon: "project-laravel" },
  tauri: { name: "Tauri", icon: "project-tauri" },
  unity: { name: "Unity", icon: "project-unity" },
  godot: { name: "Godot", icon: "file-godot" },
  go: { name: "Go", icon: "file-go" },
  rust: { name: "Rust", icon: "file-rust" },
  python: { name: "Python", icon: "file-python" },
  node: { name: "Node.js", icon: "file-npm" },
  vite: { name: "Vite", icon: "project-vite" },
  gradle: { name: "Gradle", icon: "gradle-project" },
  maven: { name: "Maven", icon: "maven-project" },
  dart: { name: "Dart", icon: "file-dart" },
  php: { name: "PHP", icon: "file-php" },
  ruby: { name: "Ruby", icon: "file-ruby" },
  dotnet: { name: ".NET", icon: "file-csharp" },
  cmake: { name: "CMake", icon: "file-cmake" },
} as const satisfies Record<string, { name: string; icon: IconName }>;

export type ProjectType = keyof typeof PROJECT_TYPES;

const MANIFESTS = new Set([
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "gradle/libs.versions.toml",
  "go.mod",
  "go.work",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "setup.py",
  "setup.cfg",
  "pubspec.yaml",
  "composer.json",
  "Gemfile",
  "project.godot",
  "CMakeLists.txt",
  "ProjectSettings/ProjectVersion.txt",
  "src-tauri/tauri.conf.json",
]);

export const isProjectManifest = (path: string) => MANIFESTS.has(path) || /^[^/]+\.[cf]sproj$/i.test(path);

function dependencies(text: string | undefined): Set<string> {
  try {
    const value: unknown = JSON.parse(text ?? "");
    if (!value || typeof value !== "object") return new Set();
    const pkg = value as Record<string, unknown>;
    return new Set(
      ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((key) => {
        const deps = pkg[key];
        return deps && typeof deps === "object" && !Array.isArray(deps) ? Object.keys(deps) : [];
      }),
    );
  } catch {
    return new Set();
  }
}

function pythonDependencies(files: ReadonlyMap<string, string>): string {
  const requirements = (files.get("requirements.txt") ?? "").replace(/^\s*#.*$/gm, "");
  const declarations: string[] = [requirements];
  for (const name of ["pyproject.toml", "Pipfile"]) {
    let section = "";
    const text = files.get(name) ?? "";
    for (const line of text.split("\n")) {
      const header = /^\s*\[([^\]]+)\]/.exec(line);
      if (header) section = header[1]!;
      if (section === "tool.poetry.dependencies" || section === "packages") {
        const dependency = /^\s*["']?([\w-]+)["']?\s*=/.exec(line);
        if (dependency) declarations.push(dependency[1]!);
      }
    }
    const project = /(?:^|\n)\[project\]([\s\S]*?)(?=\n\[|$)/.exec(text)?.[1] ?? "";
    const list = /(?:^|\n)\s*dependencies\s*=\s*\[((?:[^\]"']|"(?:[^"\\]|\\.)*"|'[^']*')*)\]/.exec(project)?.[1];
    if (list) declarations.push(list.replace(/^\s*#.*$/gm, ""));
  }
  return declarations.join("\n");
}

/** More specific frameworks precede their underlying libraries/languages. */
export function detectProjectType(files: ReadonlyMap<string, string>): ProjectType | null {
  const gradle = [...files]
    .filter(([name]) => /(?:\.gradle(?:\.kts)?|\.versions\.toml|gradle\.properties)$/.test(name))
    .map(([, text]) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|^\s*#.*$/gm, ""))
    .join("\n");
  const pom = files.get("pom.xml");
  const groups = pom
    ? [...new DOMParser().parseFromString(pom, "application/xml").getElementsByTagName("groupId")].map(
        (el) => el.textContent?.trim() ?? "",
      )
    : [];
  const jvm = (id: string) =>
    groups.some((g) => g === id || g.startsWith(`${id}.`)) ||
    new RegExp(`["']${id.replaceAll(".", "\\.")}(?:[.:][^"']*)?["']`).test(gradle);
  if (jvm("io.quarkus")) return "quarkus";
  if (jvm("org.springframework.boot")) return "spring";
  if (jvm("io.ktor")) return "ktor";
  if (jvm("org.jetbrains.compose")) return "compose";
  if (jvm("org.jetbrains.kotlin.multiplatform") || /\bkotlin\s*\(\s*["']multiplatform["']\s*\)/.test(gradle))
    return "kmp";
  if (jvm("com.android.application") || jvm("com.android.library")) return "android";
  const pubspec = files.get("pubspec.yaml");
  if (pubspec && /\bsdk\s*:\s*["']?flutter\b/.test(pubspec.replace(/^\s*#.*$/gm, ""))) return "flutter";
  if (files.has("ProjectSettings/ProjectVersion.txt")) return "unity";
  if (files.has("project.godot")) return "godot";
  if (files.has("src-tauri/tauri.conf.json") || /^\s*tauri\s*=\s*/m.test(files.get("Cargo.toml") ?? "")) return "tauri";

  const node = dependencies(files.get("package.json"));
  for (const [dependency, type] of [
    ["next", "next"],
    ["nuxt", "nuxt"],
    ["@sveltejs/kit", "sveltekit"],
    ["@angular/core", "angular"],
    ["@nestjs/core", "nest"],
    ["astro", "astro"],
    ["svelte", "svelte"],
    ["vue", "vue"],
    ["react", "react"],
    ["express", "express"],
  ] as const)
    if (node.has(dependency)) return type;

  const python = pythonDependencies(files);
  for (const type of ["fastapi", "django", "flask"] as const) {
    if (new RegExp(`(?:^\\s*|["'])${type}(?=[\\s\\[<>=!~;@"']|$)`, "im").test(python)) return type;
  }
  try {
    const composer = JSON.parse(files.get("composer.json") ?? "{}") as { require?: Record<string, unknown> };
    if (composer?.require && Object.hasOwn(composer.require, "laravel/framework")) return "laravel";
  } catch {
    /* An incomplete manifest keeps its language fallback. */
  }

  if (node.has("vite")) return "vite";

  for (const [manifest, type] of [
    ["go.mod", "go"],
    ["go.work", "go"],
    ["Cargo.toml", "rust"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["Pipfile", "python"],
    ["setup.py", "python"],
    ["setup.cfg", "python"],
    ["pubspec.yaml", "dart"],
    ["pom.xml", "maven"],
    ["build.gradle.kts", "gradle"],
    ["build.gradle", "gradle"],
    ["settings.gradle.kts", "gradle"],
    ["settings.gradle", "gradle"],
    ["package.json", "node"],
    ["composer.json", "php"],
    ["Gemfile", "ruby"],
    ["CMakeLists.txt", "cmake"],
  ] as const)
    if (files.has(manifest)) return type;
  return [...files.keys()].some((name) => /\.[cf]sproj$/i.test(name)) ? "dotnet" : null;
}
