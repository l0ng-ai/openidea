/**
 * Django field lookups in Python code: in `Coffee.objects.filter(` (and `exclude`, `get`, `Q(`
 * inside them, …) the keyword completes the model's fields, `__` follows a relation to its model's
 * fields, and after a field come its lookups (`name__icontains`). Models are read from the
 * project's `models.py` files; fields and managers on instances come from basedpyright with
 * django-types.
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorDocContext } from "@/editor/api";
import { call, commands } from "@/platform/ipc";
import { callArgs, masks, pyString } from "./pyscan";

export interface ModelField {
  name: string;
  /** `CharField`, `ForeignKey`, `reverse`… */
  type: string;
  /** The model a relation points to: as written in a parsed model (`Category`, `"shop.Category"`, `"self"`), a key in `modelFields`. */
  to?: string;
  /** A relation's `related_name` / `related_query_name`. */
  related?: string;
  relatedQuery?: string;
}

export interface Model {
  /** `app.Model`, the app being the folder of its models.py. */
  key: string;
  name: string;
  app: string;
  bases: string[];
  abstract: boolean;
  fields: ModelField[];
}

const RELATIONS = new Set(["ForeignKey", "OneToOneField", "ManyToManyField"]);
const LOOKUPS = [
  "exact",
  "iexact",
  "contains",
  "icontains",
  "in",
  "gt",
  "gte",
  "lt",
  "lte",
  "startswith",
  "istartswith",
  "endswith",
  "iendswith",
  "range",
  "isnull",
  "regex",
  "iregex",
];
/** What follows a relation besides the related model's fields. */
const RELATION_LOOKUPS = ["exact", "in", "isnull", "gt", "gte", "lt", "lte"];
const DATE_LOOKUPS = ["date", "year", "iso_year", "month", "day", "week", "week_day", "iso_week_day", "quarter"];
const TIME_LOOKUPS = ["time", "hour", "minute", "second"];
const QUERIES = new Set(["filter", "exclude", "get", "get_or_create", "update_or_create"]);

const indent = (line: string) => line.length - line.trimStart().length;

/** Model classes of a models.py (of app `app`): `class X(…):` and the fields assigned in its body. */
export function parseModels(text: string, app = ""): Model[] {
  const { code, bare } = masks(text);
  const models: Model[] = [];
  let current: Model | null = null;
  let body = 0;
  let offset = 0;
  for (const line of code.split("\n")) {
    const at = offset;
    offset += line.length + 1;
    // Comments are blanked: a comment at column 0 doesn't end a class.
    if (!line.trim()) continue;
    const cls = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/.exec(line);
    if (cls) {
      const bases = cls[2]!.split(",").map((b) => b.trim().split(".").pop()!);
      current = { key: `${app}.${cls[1]}`, name: cls[1]!, app, bases, abstract: false, fields: [] };
      models.push(current);
      body = 0;
      continue;
    }
    if (!current) continue;
    if (!indent(line)) {
      current = null;
      continue;
    }
    body ||= indent(line);
    if (indent(line) > body) {
      if (/^\s*abstract\s*=\s*True\b/.test(line)) current.abstract = true;
      continue;
    }
    const field = /^\s*(\w+)\s*(?::[^=]+)?=\s*(?:[\w.]+\.)?(\w+(?:Field|Key))\s*\(/.exec(line);
    if (!field) continue;
    const [, name, type] = field;
    const args = callArgs(code, bare, at + field[0].length - 1);
    const kw = (key: string) => {
      const arg = args.find((a) => a.key === key);
      return (arg && pyString(arg.value)) ?? undefined;
    };
    const first = args.find((a) => !a.key)?.value;
    const to = RELATIONS.has(type!) && first ? (pyString(first) ?? (/^[\w.]+$/.test(first) ? first : null)) : null;
    const related = kw("related_name");
    const relatedQuery = kw("related_query_name");
    current.fields.push({
      name: name!,
      type: type!,
      ...(to && { to }),
      ...(related && { related }),
      ...(relatedQuery && { relatedQuery }),
    });
  }
  return models;
}

/** The key of the model `ref` names from `from` (`"self"`, `"app.Model"`, `Model`: same app first). */
function resolve(byKey: Map<string, Model>, ref: string, from: Model): string | null {
  if (ref === "self") return from.key;
  if (ref.includes(".")) return byKey.has(ref) ? ref : null;
  if (byKey.has(`${from.app}.${ref}`)) return `${from.app}.${ref}`;
  return [...byKey.values()].find((m) => m.name === ref)?.key ?? null;
}

/**
 * Fields by model key: `pk`, `id`, what a model inherits from project models, `<fk>_id`, and the
 * reverse relations concrete models point at it with (`related_query_name`, `related_name`, else
 * the lowercase model name; none for a name ending in `+`).
 */
export function modelFields(models: readonly Model[]): Map<string, ModelField[]> {
  const byKey = new Map(models.map((m) => [m.key, m]));
  const own = (m: Model, seen = new Set<string>()): ModelField[] => {
    if (seen.has(m.key)) return [];
    seen.add(m.key);
    const inherited = m.bases.flatMap((b) => {
      const key = resolve(byKey, b, m);
      return key ? own(byKey.get(key)!, seen) : [];
    });
    return [...inherited, ...m.fields];
  };
  // A model's own relations: its fields and what abstract bases copy into it, not those of a
  // concrete parent (multi-table inheritance), which point back from the parent alone.
  const declared = (m: Model, seen = new Set<string>()): ModelField[] => {
    if (seen.has(m.key)) return [];
    seen.add(m.key);
    const copied = m.bases.flatMap((b) => {
      const key = resolve(byKey, b, m);
      const base = key ? byKey.get(key)! : null;
      return base?.abstract ? declared(base, seen) : [];
    });
    return [...copied, ...m.fields];
  };
  const out = new Map<string, ModelField[]>();
  for (const m of models) {
    const fields = own(m).flatMap((f): ModelField[] => {
      if (!f.to) return [f];
      const to = resolve(byKey, f.to, m) ?? undefined;
      const field: ModelField = { ...f, to };
      if (!to) delete field.to;
      return f.type === "ManyToManyField" ? [field] : [field, { name: `${f.name}_id`, type: "AutoField" }];
    });
    out.set(m.key, [{ name: "pk", type: "AutoField" }, { name: "id", type: "AutoField" }, ...fields]);
  }
  for (const m of models) {
    if (m.abstract) continue;
    for (const f of declared(m)) {
      const to = f.to && resolve(byKey, f.to, m);
      const target = to ? out.get(to) : undefined;
      const name = (f.relatedQuery ?? f.related ?? m.name.toLowerCase())
        .replace("%(class)s", m.name.toLowerCase())
        .replace("%(app_label)s", m.app);
      if (target && !name.endsWith("+")) target.push({ name, type: "reverse", to: m.key });
    }
  }
  return out;
}

/** The model key a `Model.objects` query in `app` means: that app's own model of the name first. */
export function modelKey(fields: Map<string, ModelField[]>, name: string, app: string): string | null {
  if (fields.has(`${app}.${name}`)) return `${app}.${name}`;
  return [...fields.keys()].find((k) => k.slice(k.lastIndexOf(".") + 1) === name) ?? null;
}

/** The model of `Model.objects[.method(…)…].query(` whose `(` is at `open` in `bare`. */
function queryModel(bare: string, open: number): string | null {
  let i = open;
  const word = () => {
    const m = /(\w+)\s*$/.exec(bare.slice(0, i));
    if (!m) return null;
    i -= m[0].length;
    return m[1]!;
  };
  const dot = () => {
    const m = /\.\s*$/.exec(bare.slice(0, i));
    if (m) i -= m[0].length;
    return !!m;
  };
  if (!QUERIES.has(word() ?? "")) return null;
  for (let steps = 0; steps < 20 && dot(); steps++) {
    while (i > 0 && /\s/.test(bare[i - 1]!)) i--;
    if (bare[i - 1] === ")") {
      // An earlier call of the chain: `.exclude(Q(a=1)).filter(`.
      let depth = 0;
      for (i--; i >= 0; i--) {
        if (bare[i] === ")") depth++;
        else if (bare[i] === "(" && --depth === 0) break;
      }
      if (i < 0 || !word()) return null;
      continue;
    }
    if (word() !== "objects" || !dot()) return null;
    const model = word();
    return model && /^[A-Z]/.test(model) ? model : null;
  }
  return null;
}

/** The model and the lookup typed so far, when the caret is at a keyword of a query (or of a `Q(` inside one). */
export function lookupAt(before: string): { model: string; path: string[]; word: string } | null {
  const { bare, inString } = masks(before);
  if (inString) return null;
  const opens: number[] = [];
  const commas: number[] = [];
  let comma = -1;
  for (let i = 0; i < bare.length; i++) {
    const c = bare[i];
    if (c === "(" || c === "[" || c === "{") {
      opens.push(i);
      commas.push(comma);
      comma = -1;
    } else if ((c === ")" || c === "]" || c === "}") && opens.length) {
      opens.pop();
      comma = commas.pop()!;
    } else if (c === ",") comma = i;
  }
  const open = opens.at(-1);
  if (open === undefined || bare[open] !== "(") return null;
  const kw = /^\s*(\w*)$/.exec(before.slice(Math.max(comma, open) + 1));
  if (!kw) return null;
  // `Q(` may sit in a query's arguments: the query is the nearest enclosing call.
  const callee = /(\w+)\s*$/.exec(bare.slice(0, open))?.[1];
  const candidates = callee === "Q" ? opens.slice(0, -1).reverse() : [open];
  const model = candidates.map((o) => (bare[o] === "(" ? queryModel(bare, o) : null)).find(Boolean);
  if (!model) return null;
  const parts = kw[1]!.split("__");
  return { model, path: parts.slice(0, -1), word: parts[parts.length - 1]! };
}

/** What may follow `path` on model `key`: fields of the model the path leads to (and the lookups of a relation), or a field's lookups. */
export function lookupOptions(
  fields: Map<string, ModelField[]>,
  key: string,
  path: readonly string[],
): Array<{ label: string; detail?: string; field: boolean }> {
  let current = fields.get(key);
  let last: ModelField | null = null;
  for (const name of path) {
    if (!current) return [];
    last = current.find((f) => f.name === name) ?? null;
    if (!last) return [];
    current = last.to ? fields.get(last.to) : undefined;
  }
  const lookups = (names: readonly string[]) => names.map((l) => ({ label: l, field: false }));
  if (current) {
    const own = current.map((f) => ({ label: f.name, detail: f.to?.split(".").pop() ?? f.type, field: true }));
    return last ? [...own, ...lookups(RELATION_LOOKUPS)] : own;
  }
  if (!last) return [];
  if (last.to) return lookups(RELATION_LOOKUPS);
  const extra = /^Date/.test(last.type) ? DATE_LOOKUPS : [];
  const time = /^(?:DateTime|Time)Field$/.test(last.type) ? TIME_LOOKUPS : [];
  return lookups([...LOOKUPS, ...extra, ...time]);
}

/** The app a file belongs to: the folder of its models.py (`shop/models.py`, `shop/views.py` → `shop`). */
export const appOf = (path: string) => path.split("/").at(-2) ?? "";

let cache: Promise<Map<string, ModelField[]>> | null = null;

/** Fields of the project's models (read once, until a models.py changes or indexing ends). */
export function projectModels(): Promise<Map<string, ModelField[]>> {
  const read = (cache ??= (async () => {
    const paths = (await call(commands.findFilesNamed("models.py")))
      .map(String)
      .filter((p) => !/\/(?:site-packages|node_modules|\.venv|venv)\//.test(p));
    const texts = await Promise.all(paths.map((p) => call(commands.fsReadText(p)).catch(() => "")));
    return modelFields(texts.flatMap((t, i) => parseModels(t, appOf(paths[i]!))));
  })().catch(() => new Map<string, ModelField[]>()));
  // Nothing found (the index may still be building): ask again next time.
  void read.then((models) => !models.size && cache === read && (cache = null));
  return read;
}

export const forgetModels = () => void (cache = null);

export function lookupCompletion(path: string) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const at = lookupAt(ctx.state.sliceDoc(Math.max(0, ctx.pos - 1000), ctx.pos));
    if (!at) return null;
    const fields = await projectModels();
    const key = modelKey(fields, at.model, appOf(path));
    const options = key ? lookupOptions(fields, key, at.path) : [];
    if (ctx.aborted || !options.length) return null;
    // The whole keyword (`category__name`), so the list merges with sources completing the word.
    const prefix = at.path.map((p) => `${p}__`).join("");
    return {
      from: ctx.pos - prefix.length - at.word.length,
      options: options.map((o) => ({
        label: prefix + o.label,
        detail: o.detail,
        type: o.field ? "property" : "keyword",
        // Above the language server's names (auto-imports) at a query keyword.
        boost: 50,
      })),
    };
  };
}

export function lookupCompletionExtension(doc: EditorDocContext): Extension {
  return doc.language === "python" && !doc.virtual && !doc.readOnly
    ? EditorState.languageData.of(() => [{ openideaCompletion: lookupCompletion(doc.path) }])
    : [];
}
