/** Root build/SDK markers only; no dependency parsing or tool execution. */
import type { IconName } from "@/ui/icons";

type Marker = string | RegExp;
interface ProjectTypeDefinition {
  name: string;
  icon: IconName;
  markers: readonly Marker[];
  requires?: readonly string[];
}

// Add project types here: icons, detection, sorting and refresh all use this registry.
// The first match wins; put specific SDK/build markers before their generic fallback.
export const PROJECT_TYPES = {
  flutter: { name: "Flutter", icon: "project-flutter", markers: ["pubspec.yaml"], requires: [".metadata"] },
  dart: { name: "Dart", icon: "file-dart", markers: ["pubspec.yaml"] },
  vite: { name: "Vite", icon: "project-vite", markers: [/^vite\.config\.[cm]?[jt]s$/], requires: ["package.json"] },
  gradle: {
    name: "Gradle",
    icon: "gradle-project",
    markers: ["build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle"],
  },
  maven: { name: "Maven", icon: "maven-project", markers: ["pom.xml"] },
  go: { name: "Go", icon: "file-go", markers: ["go.mod", "go.work"] },
  cargo: { name: "Cargo", icon: "file-cargo", markers: ["Cargo.toml"] },
  python: {
    name: "Python",
    icon: "file-python",
    markers: ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "setup.cfg"],
  },
  node: { name: "Node.js", icon: "file-npm", markers: ["package.json"] },
  php: { name: "PHP", icon: "file-php", markers: ["composer.json"] },
  ruby: { name: "Ruby", icon: "file-ruby", markers: ["Gemfile"] },
  swift: { name: "Swift", icon: "file-swift", markers: ["Package.swift"] },
  zig: { name: "Zig", icon: "file-zig", markers: ["build.zig"] },
  godot: { name: "Godot", icon: "file-godot", markers: ["project.godot"] },
  cmake: { name: "CMake", icon: "file-cmake", markers: ["CMakeLists.txt"] },
  make: { name: "Make", icon: "file-makefile", markers: ["Makefile", "makefile", "GNUmakefile"] },
  dotnet: { name: ".NET", icon: "file-csharp", markers: [/^[^/]+\.(?:[cf]sproj|slnx?)$/i] },
} as const satisfies Record<string, ProjectTypeDefinition>;

export type ProjectType = keyof typeof PROJECT_TYPES;
const definitions = Object.entries(PROJECT_TYPES) as [ProjectType, ProjectTypeDefinition][];
const matches = (name: string, marker: Marker) => (typeof marker === "string" ? name === marker : marker.test(name));

export function isProjectMarker(name: string): boolean {
  return definitions.some(
    ([, type]) => type.markers.some((marker) => matches(name, marker)) || type.requires?.includes(name),
  );
}

export function detectProjectType(files: ReadonlySet<string>): ProjectType | null {
  for (const [id, type] of definitions) {
    if (type.requires?.some((name) => !files.has(name))) continue;
    if (type.markers.some((marker) => [...files].some((name) => matches(name, marker)))) return id;
  }
  return null;
}
