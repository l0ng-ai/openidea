/**
 * Django field lookups in Python code: in `Coffee.objects.filter(` (and `exclude`, `get`, …) the
 * keyword completes the model's fields, `__` follows a relation to its model's fields, and after a
 * plain field come its lookups (`name__icontains`). Models are read from the project's `models.py`
 * files; fields and managers on instances come from basedpyright with django-types.
 */
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorDocContext } from "@/editor/api";
import { call, commands } from "@/platform/ipc";

export interface ModelField {
  name: string;
  /** `CharField`, `ForeignKey`… */
  type: string;
  /** Model name a relation points to (a reverse relation too). */
  to?: string;
  /** A relation's `related_name`. */
  related?: string;
}

export interface Model {
  name: string;
  bases: string[];
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
const DATE_LOOKUPS = ["date", "year", "iso_year", "month", "day", "week", "week_day", "iso_week_day", "quarter"];
const TIME_LOOKUPS = ["time", "hour", "minute", "second"];

/** Model classes of a models.py: `class X(…Model…):` and the fields assigned in its body. */
export function parseModels(text: string): Model[] {
  const models: Model[] = [];
  let current: Model | null = null;
  for (const line of text.split("\n")) {
    const cls = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/.exec(line);
    if (cls) {
      const bases = cls[2]!.split(",").map((b) => b.trim().split(".").pop()!);
      current = { name: cls[1]!, bases, fields: [] };
      models.push(current);
      continue;
    }
    if (/^\S/.test(line)) current = null;
    const field =
      current && /^ {4}(\w+)\s*(?::[^=]+)?=\s*(?:[\w.]+\.)?(\w+(?:Field|Key))\(\s*(?:(["']?)([\w.]+)\3)?/.exec(line);
    if (!current || !field) continue;
    const [, name, type, , target] = field;
    const to = RELATIONS.has(type!) ? (target === "self" ? current.name : target?.split(".").pop()) : undefined;
    const related = /related_name\s*=\s*["'](\w+)["']/.exec(line)?.[1];
    current.fields.push({ name: name!, type: type!, ...(to && { to }), ...(related && { related }) });
  }
  return models;
}

/**
 * Fields by model name, with what a model inherits from project models and the reverse relations
 * other models point at it with (`related_name`, else the lowercase model name).
 */
export function modelFields(models: readonly Model[]): Map<string, ModelField[]> {
  const byName = new Map(models.map((m) => [m.name, m]));
  const own = (m: Model, seen = new Set<string>()): ModelField[] => {
    if (seen.has(m.name)) return [];
    seen.add(m.name);
    const inherited = m.bases.flatMap((b) => (byName.has(b) ? own(byName.get(b)!, seen) : []));
    return [...inherited, ...m.fields];
  };
  const out = new Map<string, ModelField[]>();
  for (const m of models)
    out.set(m.name, [{ name: "pk", type: "AutoField" }, { name: "id", type: "AutoField" }, ...own(m)]);
  for (const m of models)
    for (const f of own(m)) {
      const target = f.to && out.get(f.to);
      if (target && f.related !== "+")
        target.push({ name: f.related ?? m.name.toLowerCase(), type: "reverse", to: m.name });
    }
  return out;
}

const QUERY =
  /\b([A-Z]\w*)\.objects(?:\.\w+\([^()]*\))*\.(?:filter|exclude|get|get_or_create|update_or_create)\(([^()]*)$/;

/** The model and the lookup typed so far, when the caret is at a keyword of a `Model.objects.filter(` call. */
export function lookupAt(before: string): { model: string; path: string[]; word: string } | null {
  const m = QUERY.exec(before);
  if (!m) return null;
  const kw = /(?:^|,)\s*(\w*)$/.exec(m[2]!);
  if (!kw) return null;
  const parts = kw[1]!.split("__");
  return { model: m[1]!, path: parts.slice(0, -1), word: parts[parts.length - 1]! };
}

/** What may follow `path` on `model`: fields (of the model the path leads to) or a field's lookups. */
export function lookupOptions(
  fields: Map<string, ModelField[]>,
  model: string,
  path: readonly string[],
): Array<{ label: string; detail?: string; field: boolean }> {
  let current = fields.get(model);
  let last: ModelField | null = null;
  for (const name of path) {
    if (!current) return [];
    last = current.find((f) => f.name === name) ?? null;
    if (!last) return [];
    current = last.to ? fields.get(last.to) : undefined;
  }
  if (current) return current.map((f) => ({ label: f.name, detail: f.to ?? f.type, field: true }));
  if (!last || last.to) return [];
  const extra = /^Date/.test(last.type) ? DATE_LOOKUPS : [];
  const time = /^(?:DateTime|Time)Field$/.test(last.type) ? TIME_LOOKUPS : [];
  return [...LOOKUPS, ...extra, ...time].map((l) => ({ label: l, field: false }));
}

let cache: Promise<Map<string, ModelField[]>> | null = null;

/** Fields of the project's models (read once, until a models.py changes). */
export function projectModels(): Promise<Map<string, ModelField[]>> {
  cache ??= (async () => {
    const paths = (await call(commands.findFilesNamed("models.py")))
      .map(String)
      .filter((p) => !/\/(?:site-packages|node_modules|\.venv|venv)\//.test(p));
    const texts = await Promise.all(paths.map((p) => call(commands.fsReadText(p)).catch(() => "")));
    return modelFields(texts.flatMap((t) => parseModels(t)));
  })().catch(() => new Map());
  return cache;
}

export const forgetModels = () => void (cache = null);

async function completion(ctx: CompletionContext): Promise<CompletionResult | null> {
  const at = lookupAt(ctx.state.sliceDoc(Math.max(0, ctx.pos - 500), ctx.pos));
  if (!at) return null;
  const options = lookupOptions(await projectModels(), at.model, at.path);
  if (ctx.aborted || !options.length) return null;
  // The whole keyword (`category__name`), so the list merges with sources completing the word.
  const prefix = at.path.map((p) => `${p}__`).join("");
  return {
    from: ctx.pos - prefix.length - at.word.length,
    options: options.map((o) => ({
      label: prefix + o.label,
      detail: o.detail,
      type: o.field ? "property" : "keyword",
    })),
  };
}

export function lookupCompletionExtension(doc: EditorDocContext): Extension {
  return doc.language === "python" && !doc.virtual && !doc.readOnly
    ? EditorState.languageData.of(() => [{ openideaCompletion: completion }])
    : [];
}
