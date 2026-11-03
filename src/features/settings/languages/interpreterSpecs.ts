/**
 * Languages the status-bar interpreter widget can show, in the order it auto-picks them. Each
 * names the SDK kind, the setting a pick writes and how the language's files are recognised.
 */
import { tx } from "@/platform/i18n";
import type { LanguagesSettings } from "@/bindings";
import { effectivePython, type Sdk, type SdkKind } from "./api";

export interface InterpreterSpec {
  id: string;
  /** Name in the language list (`PHP`). */
  label: string;
  /** Header of the choices and name of the settings they come from (`PHP Interpreter`). */
  title: string;
  /** Accessible name of the button for the interpreter it shows. */
  ariaLabel: (name: string) => string;
  sdkKind: SdkKind;
  /** Setting a pick writes (`languages.php.interpreter`). */
  setting: string;
  /** Settings page opened from the widget. */
  page: string;
  /** File names that mark a project of the language. */
  markers: string[];
  /** Queries finding the language's files in the project. */
  queries: string[];
  isPath: (path: string) => boolean;
  configured: (languages: LanguagesSettings | undefined) => string;
  /** The interpreter in use, given the configured one and the detected installations. */
  effective: (configured: string, sdks: Sdk[]) => Promise<string | null>;
}

const baseName = (path: string) => path.replaceAll("\\", "/").split("/").at(-1)!;

/** What the language's tools pick on their own: the first detected installation. */
const firstDetected = async (configured: string, sdks: Sdk[]): Promise<string | null> =>
  configured || sdks[0]?.path || null;

const pythonMarkers = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "pyrightconfig.json",
  "ty.toml",
  "uv.lock",
  "poetry.lock",
  "SConstruct",
  "SConscript",
  ".python-version",
];

export function isPythonPath(path: string): boolean {
  const name = baseName(path);
  return /\.(py|pyi|pyw)$/.test(name) || pythonMarkers.includes(name) || /^requirements[\w.-]*\.txt$/.test(name);
}

const phpMarkers = ["composer.json", "composer.lock", "phpunit.xml", "phpunit.xml.dist", "phpunit.dist.xml", "artisan"];

/** PHP sources and the files that make a PHP project (Composer, PHPUnit, Laravel). */
export function isPhpPath(path: string): boolean {
  const name = baseName(path);
  return /\.(php|phtml|php[3-8]|phps|phpt)$/.test(name) || phpMarkers.includes(name);
}

const javaMarkers = ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];
const nodeMarkers = ["package.json"];
const goMarkers = ["go.mod", "go.work"];
const rustMarkers = ["Cargo.toml"];

/** Python first: it is the default when nothing says otherwise. */
export const INTERPRETER_SPECS: readonly InterpreterSpec[] = [
  {
    id: "python",
    label: "Python",
    title: "Python Interpreter",
    ariaLabel: (name) => tx`Python Interpreter: ${name}`,
    sdkKind: "python",
    setting: "languages.python.interpreter",
    page: "python.interpreter",
    markers: pythonMarkers,
    queries: [".py", "requirements", ...pythonMarkers],
    isPath: isPythonPath,
    configured: (l) => l?.python?.interpreter ?? "",
    // The backend knows the project's virtualenv and the Python the project pins.
    effective: () => effectivePython(),
  },
  {
    id: "php",
    label: "PHP",
    title: "PHP Interpreter",
    ariaLabel: (name) => tx`PHP Interpreter: ${name}`,
    sdkKind: "php",
    setting: "languages.php.interpreter",
    page: "languages.php",
    markers: phpMarkers,
    queries: [".php", ...phpMarkers],
    isPath: isPhpPath,
    configured: (l) => l?.php?.interpreter ?? "",
    effective: firstDetected,
  },
  {
    id: "java",
    label: "Java",
    title: "Java SDK",
    ariaLabel: (name) => tx`Java SDK: ${name}`,
    sdkKind: "jdk",
    setting: "languages.java.jdk",
    page: "languages.java",
    markers: javaMarkers,
    queries: [".java", ...javaMarkers],
    isPath: (p) => /\.(java|kt|kts|scala|groovy)$/.test(baseName(p)) || javaMarkers.includes(baseName(p)),
    configured: (l) => l?.java?.jdk ?? "",
    effective: firstDetected,
  },
  {
    id: "node",
    label: "Node.js",
    title: "Node.js Interpreter",
    ariaLabel: (name) => tx`Node.js Interpreter: ${name}`,
    sdkKind: "node",
    setting: "languages.node.interpreter",
    page: "languages.node",
    markers: nodeMarkers,
    queries: nodeMarkers,
    isPath: (p) => /\.[cm]?[jt]sx?$/.test(baseName(p)) || nodeMarkers.includes(baseName(p)),
    configured: (l) => l?.node?.interpreter ?? "",
    effective: firstDetected,
  },
  {
    id: "go",
    label: "Go",
    title: "Go SDK",
    ariaLabel: (name) => tx`Go SDK: ${name}`,
    sdkKind: "go",
    setting: "languages.go.goroot",
    page: "languages.go",
    markers: goMarkers,
    queries: [".go", ...goMarkers],
    isPath: (p) => baseName(p).endsWith(".go") || goMarkers.includes(baseName(p)),
    configured: (l) => l?.go?.goroot ?? "",
    effective: firstDetected,
  },
  {
    id: "rust",
    label: "Rust",
    title: "Rust Toolchain",
    ariaLabel: (name) => tx`Rust Toolchain: ${name}`,
    sdkKind: "rust",
    setting: "languages.rust.toolchain",
    page: "languages.rust",
    markers: rustMarkers,
    queries: [".rs", ...rustMarkers],
    isPath: (p) => baseName(p).endsWith(".rs") || rustMarkers.includes(baseName(p)),
    configured: (l) => l?.rust?.toolchain ?? "",
    effective: firstDetected,
  },
];
