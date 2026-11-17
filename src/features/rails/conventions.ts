/**
 * Rails' file conventions for Navigate › Related Symbol: a controller (and the action at the
 * caret) with its views, helper and model; a view with its controller action; a model with its
 * controller and migrations.
 */

export interface RailsFs {
  /** The file names in `dir`, or null when it doesn't exist. */
  list(dir: string): Promise<string[] | null>;
  read(path: string): Promise<string | null>;
}

export type RailsGroup = "view" | "controller" | "helper" | "model" | "migration";

export interface RailsTarget {
  path: string;
  group: RailsGroup;
  line?: number;
  label?: string;
}

type RailsFile =
  | { kind: "controller"; root: string; resource: string }
  | { kind: "helper"; root: string; resource: string }
  | { kind: "view"; root: string; resource: string; file: string }
  | { kind: "model"; root: string; model: string };

const IRREGULAR: Record<string, string> = { person: "people", man: "men", woman: "women", child: "children" };
const IRREGULAR_SINGULAR = Object.fromEntries(Object.entries(IRREGULAR).map(([s, p]) => [p, s]));

export function pluralize(word: string): string {
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

export function singularize(word: string): string {
  if (IRREGULAR_SINGULAR[word]) return IRREGULAR_SINGULAR[word];
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

const camel = (s: string) => s.replace(/(?:^|_)([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** `admin/users` → `Admin::UsersController`. */
export function controllerName(resource: string): string {
  return `${resource.split("/").map(camel).join("::")}Controller`;
}

export function railsFile(path: string): RailsFile | null {
  const m = /^(.*)\/app\/(controllers|views|helpers|models)\/(.+)$/.exec(path);
  if (!m) return null;
  const [, root, dir, rest] = m as unknown as [string, string, string, string];
  if (dir === "controllers") {
    const c = /^(.+)_controller\.rb$/.exec(rest);
    return c && c[1] !== "application" ? { kind: "controller", root, resource: c[1]! } : null;
  }
  if (dir === "helpers") {
    const h = /^(.+)_helper\.rb$/.exec(rest);
    return h && h[1] !== "application" ? { kind: "helper", root, resource: h[1]! } : null;
  }
  if (dir === "views") {
    const slash = rest.lastIndexOf("/");
    if (slash < 0) return null;
    const resource = rest.slice(0, slash);
    if (resource === "layouts" || resource.startsWith("layouts/")) return null;
    return { kind: "view", root, resource, file: rest.slice(slash + 1) };
  }
  const model = /^(.+)\.rb$/.exec(rest);
  return model && !model[1]!.startsWith("concerns/") ? { kind: "model", root, model: model[1]! } : null;
}

const DEF = /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?]?)/;

/** The method whose `def` is nearest above `offset` (the action at the caret), if any. */
export function actionAt(text: string, offset: number): string | null {
  const lines = text.slice(0, offset).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = DEF.exec(lines[i]!);
    if (m) return m[1]!;
    if (/^\s*class\s/.test(lines[i]!)) return null;
  }
  return null;
}

/** The 0-based line of `def name` in `text`. */
export function defLine(text: string, name: string): number | undefined {
  const i = text.split("\n").findIndex((l) => DEF.exec(l)?.[1] === name);
  return i < 0 ? undefined : i;
}

/** The view's action: its name up to the first dot; partials (`_form`) have none. */
const viewAction = (file: string) => (file.startsWith("_") ? null : file.split(".")[0]!);

async function views(fs: RailsFs, root: string, resource: string, action: string | null): Promise<RailsTarget[]> {
  const dir = `${root}/app/views/${resource}`;
  const names = (await fs.list(dir)) ?? [];
  return names
    .filter((n) => action === null || n.startsWith(`${action}.`))
    .sort()
    .map((n) => ({ path: `${dir}/${n}`, group: "view" }));
}

async function existing(fs: RailsFs, path: string, group: RailsGroup, label?: string): Promise<RailsTarget[]> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  const names = await fs.list(dir);
  return names?.includes(path.slice(dir.length + 1)) ? [{ path, group, label }] : [];
}

async function controller(fs: RailsFs, root: string, resource: string, action: string | null): Promise<RailsTarget[]> {
  const path = `${root}/app/controllers/${resource}_controller.rb`;
  const text = await fs.read(path);
  if (text === null) return [];
  const line = action ? defLine(text, action) : undefined;
  const name = controllerName(resource);
  return [{ path, group: "controller", line, label: line === undefined ? name : `${name}#${action}` }];
}

const lastSegment = (resource: string) => resource.slice(resource.lastIndexOf("/") + 1);

export async function railsTargets(path: string, text: string, offset: number, fs: RailsFs): Promise<RailsTarget[]> {
  const file = railsFile(path);
  if (!file) return [];
  const { root } = file;
  switch (file.kind) {
    case "controller": {
      const action = actionAt(text, offset);
      return [
        ...(await views(fs, root, file.resource, action)),
        ...(await existing(fs, `${root}/app/helpers/${file.resource}_helper.rb`, "helper")),
        ...(await existing(fs, `${root}/app/models/${singularize(lastSegment(file.resource))}.rb`, "model")),
      ];
    }
    case "view":
      return [
        ...(await controller(fs, root, file.resource, viewAction(file.file))),
        ...(await existing(fs, `${root}/app/helpers/${file.resource}_helper.rb`, "helper")),
      ];
    case "helper":
      return [...(await controller(fs, root, file.resource, null)), ...(await views(fs, root, file.resource, null))];
    case "model": {
      const table = pluralize(lastSegment(file.model));
      const migrations = ((await fs.list(`${root}/db/migrate`)) ?? [])
        .filter((n) => new RegExp(`^\\d+_\\w*(?:create|to)_${table}\\.rb$`).test(n))
        .sort()
        .map((n): RailsTarget => ({ path: `${root}/db/migrate/${n}`, group: "migration" }));
      return [...(await controller(fs, root, table, null)), ...migrations];
    }
  }
}
