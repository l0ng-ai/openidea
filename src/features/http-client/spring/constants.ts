/**
 * Constants that mapping paths take from other classes: `Paths.API + "/orders"`,
 * statically imported ones and those of a superclass. Their classes are found by
 * file name in the index, read and kept until a Java / Kotlin file changes.
 */
import { call, commands } from "@/platform/ipc";
import { Constants, type ExternalConstant } from "./endpoints";
import { allClasses, parseSource, type Expr, type SourceFile } from "./source";

export interface ConstantFiles {
  /** The project's files called `name`. */
  filesNamed(name: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
}

const EXTENSIONS = [".java", ".kt"];
/** Classes looked up per pool, and how many hops from a controller to a constant's class. */
const MAX_CLASSES = 256;
const MAX_DEPTH = 3;
/** Qualifiers Spring and the JDK own: never project classes. */
const LIBRARY = new Set(["MediaType", "RequestMethod", "HttpMethod", "HttpHeaders", "HttpStatus", "String", "Integer"]);

const isClassName = (s: string | undefined): s is string => !!s && /^[A-Z]/.test(s);
const simpleType = (t: string) => t.replace(/<.*$/, "").replace(/\(.*$/, "").trim().split(".").pop() ?? "";

/** `C` of `a.b.C.NAME` / `a.b.C.*` (a static import; the parser drops the `static`). */
function staticImportClass(imp: string): string | null {
  const parts = imp.split(".");
  const owner = parts[parts.length - 2];
  return parts.length >= 3 && isClassName(owner) ? owner : null;
}

/** Classes whose constants `file` can use without naming the class. */
function inheritedClasses(file: SourceFile): string[] {
  const out = new Set<string>();
  for (const imp of file.imports) {
    const c = staticImportClass(imp);
    if (c) out.add(c);
  }
  for (const c of allClasses(file)) if (c.superclass) out.add(simpleType(c.superclass));
  return [...out].filter(isClassName);
}

function qualifiers(expr: Expr, out: Set<string>) {
  for (let i = 0; i + 2 < expr.length; i++) {
    const [a, dot, b] = [expr[i]!, expr[i + 1]!, expr[i + 2]!];
    if (a.kind === "id" && dot.kind === "p" && dot.text === "." && b.kind === "id" && isClassName(a.text))
      out.add(a.text);
  }
}

/** Classes `file` takes constants from: qualifiers in annotations and constant initializers, and the inherited ones. */
export function referencedClasses(file: SourceFile): string[] {
  const out = new Set(inheritedClasses(file));
  const classes = allClasses(file);
  for (const c of classes) {
    for (const a of [...c.annotations, ...c.methods.flatMap((m) => m.annotations)])
      for (const expr of a.args.values()) qualifiers(expr, out);
    for (const f of c.fields) if (f.init) qualifiers(f.init, out);
  }
  for (const f of file.fields) if (f.init) qualifiers(f.init, out);
  const own = new Set(classes.map((c) => c.name));
  return [...out].filter((c) => !own.has(c) && !LIBRARY.has(c));
}

export class ConstantPool {
  /** Class name → constants of its file; `null` when no project file declares it. */
  private readonly classes = new Map<string, Constants | null>();
  private readonly pending = new Map<string, Promise<SourceFile | null>>();
  private readonly resolving = new Set<string>();

  constructor(private readonly files: ConstantFiles) {}

  /** Resolves the constants `file` takes from classes loaded so far. */
  resolverFor(file: SourceFile): ExternalConstant {
    const inherited = inheritedClasses(file);
    return (qualifier, name) => {
      for (const owner of qualifier ? [qualifier] : inherited) {
        const key = `${owner}.${name}`;
        const constants = this.classes.get(owner);
        if (!constants || this.resolving.has(key)) continue;
        this.resolving.add(key);
        try {
          const v = constants.named(name);
          if (v != null) return v;
        } finally {
          this.resolving.delete(key);
        }
      }
      return null;
    };
  }

  /** Loads the classes `files` take constants from, and theirs in turn; true when one of them is now known. */
  async load(files: readonly SourceFile[]): Promise<boolean> {
    let added = false;
    let round = [...files];
    for (let depth = 0; depth < MAX_DEPTH && round.length; depth++) {
      const next: SourceFile[] = [];
      for (const file of round)
        for (const name of referencedClasses(file)) {
          if (this.classes.has(name) && !this.pending.has(name)) continue;
          if (!this.pending.has(name) && this.classes.size >= MAX_CLASSES) continue;
          const isNew = !this.pending.has(name);
          const loaded = await this.lookup(name, file);
          if (!loaded) continue;
          added = true;
          if (isNew) next.push(loaded);
        }
      round = next;
    }
    return added;
  }

  private lookup(name: string, from: SourceFile): Promise<SourceFile | null> {
    const running = this.pending.get(name);
    if (running) return running;
    this.classes.set(name, null);
    const promise = this.find(name, from)
      .then((file) => {
        if (file) {
          const constants = new Constants(file, this.resolverFor(file));
          // Nested classes too: `Outer.Inner.NAME` names `Inner`.
          for (const c of allClasses(file))
            if (c.name === name || !this.classes.get(c.name)) this.classes.set(c.name, constants);
        }
        return file;
      })
      .catch(() => null)
      .finally(() => this.pending.delete(name));
    this.pending.set(name, promise);
    return promise;
  }

  /** The file declaring class `name`, preferring the package `from` imports it from, then its own package. */
  private async find(name: string, from: SourceFile): Promise<SourceFile | null> {
    const imported = from.imports.find((i) => i.endsWith(`.${name}`) || i.includes(`.${name}.`));
    const pkg = imported ? imported.slice(0, imported.indexOf(`.${name}`)) : from.packageName;
    for (const ext of EXTENSIONS) {
      const paths = (await this.files.filesNamed(`${name}${ext}`)).map((p) => p.replace(/\\/g, "/"));
      if (!paths.length) continue;
      const suffix = `/${pkg.replace(/\./g, "/")}/${name}${ext}`;
      const path = paths.find((p) => p.endsWith(suffix)) ?? paths[0]!;
      const text = await this.files.read(path);
      if (text != null) return parseSource(text);
    }
    return null;
  }
}

const projectFiles: ConstantFiles = {
  filesNamed: async (name) => (await call(commands.findFilesNamed(name))).map(String),
  read: async (path) => {
    try {
      return await call(commands.fsReadText(path));
    } catch {
      return null;
    }
  },
};

let shared: ConstantPool | null = null;

/** The project's pool, shared by the route index and the editors. */
export function constantPool(): ConstantPool {
  return (shared ??= new ConstantPool(projectFiles));
}

/** Forgets the loaded classes (a Java / Kotlin file changed, or the project closed). */
export function resetConstantPool() {
  shared = null;
}
