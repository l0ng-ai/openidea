/**
 * References in Thymeleaf templates: fragment expressions (`~{fragments/nav :: menu}`, or the
 * bare form in `th:replace` / `th:insert` / `th:include`) and message expressions
 * (`#{home.title}`), in `th:*` / `data-th-*` attribute values and inline `[[…]]` / `[(…)]`.
 */

export type ThymeleafReference =
  | { kind: "template"; template: string; from: number; to: number }
  | { kind: "fragment"; template: string; fragment: string; from: number; to: number }
  | { kind: "message"; key: string; from: number; to: number };

const ATTRIBUTE = /\b(?:th:|data-th-)([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const INLINE = /\[\[(.*?)\]\]|\[\((.*?)\)\]/g;
/** Attributes whose whole value may be a fragment expression without `~{…}`. */
const FRAGMENT_ATTRIBUTES = new Set(["replace", "insert", "include", "substituteby"]);
const TEMPLATE_NAME = /^(?:[\w.-]+\/)*[\w.-]+$/;

interface Region {
  text: string;
  from: number;
  /** The value is a fragment expression even without `~{…}`. */
  fragment: boolean;
}

function regions(text: string): Region[] {
  const out: Region[] = [];
  for (const m of text.matchAll(ATTRIBUTE)) {
    const value = m[2] ?? m[3] ?? "";
    out.push({
      text: value,
      from: m.index + m[0].length - value.length - 1,
      fragment: FRAGMENT_ATTRIBUTES.has(m[1]!),
    });
  }
  for (const m of text.matchAll(INLINE)) {
    out.push({ text: m[1] ?? m[2] ?? "", from: m.index + 2, fragment: false });
  }
  return out;
}

/** The references of a fragment expression body (`template :: selector`) at `from`. */
function fragmentReferences(body: string, from: number): ThymeleafReference[] {
  const sep = body.indexOf("::");
  const left = sep < 0 ? body : body.slice(0, sep);
  const lead = left.length - left.trimStart().length;
  const name = left.trim();
  // `this` and an empty template name the current template.
  const template = name === "this" ? "" : name;
  if (template && !TEMPLATE_NAME.test(template)) return [];
  const out: ThymeleafReference[] = [];
  if (template) out.push({ kind: "template", template, from: from + lead, to: from + lead + name.length });
  if (sep >= 0) {
    const selector = /^\s*([\w-]+)/.exec(body.slice(sep + 2));
    if (selector) {
      const fragment = selector[1]!;
      const start = from + sep + 2 + selector[0].length - fragment.length;
      out.push({ kind: "fragment", template, fragment, from: start, to: start + fragment.length });
    }
  }
  return out;
}

/** Every reference in a template, in document order. */
export function thymeleafReferences(text: string): ThymeleafReference[] {
  const out: ThymeleafReference[] = [];
  for (const region of regions(text)) {
    let wrapped = false;
    for (const m of region.text.matchAll(/~\{([^}]*)\}/g)) {
      wrapped = true;
      out.push(...fragmentReferences(m[1]!, region.from + m.index + 2));
    }
    if (!wrapped && region.fragment && !/[$*#@]\{/.test(region.text))
      out.push(...fragmentReferences(region.text, region.from));
    for (const m of region.text.matchAll(/#\{\s*([\w.-]+)/g)) {
      const key = m[1]!;
      const start = region.from + m.index + m[0].length - key.length;
      out.push({ kind: "message", key, from: start, to: start + key.length });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

export function thymeleafReferenceAt(text: string, offset: number): ThymeleafReference | null {
  return thymeleafReferences(text).find((r) => r.from <= offset && offset < r.to) ?? null;
}

const escape = (s: string) => s.replace(/[-.]/g, "\\$&");

/** The offset of the `th:fragment` (else the `id`) defining `name`, or -1. */
export function fragmentDefinition(text: string, name: string): number {
  const fragment = new RegExp(`\\b(?:th:|data-th-)fragment\\s*=\\s*["']\\s*${escape(name)}\\s*[("']`).exec(text);
  if (fragment) return fragment.index + fragment[0].lastIndexOf(name);
  const id = new RegExp(`\\sid\\s*=\\s*["']${escape(name)}["']`).exec(text);
  return id ? id.index + id[0].lastIndexOf(name) : -1;
}

/** The offset of `key`'s definition in a `.properties` file, or -1. */
export function propertyDefinition(text: string, key: string): number {
  const m = new RegExp(`^[ \\t]*${escape(key)}[ \\t]*[=:\\s]`, "m").exec(`${text}\n`);
  return m ? m.index + m[0].indexOf(key) : -1;
}

/**
 * The folder template names resolve against: Spring Boot's `src/main/resources/templates`
 * above `path`, else the nearest `templates` folder. Paths use `/`.
 */
export function templatesRoot(path: string): string | null {
  const spring = path.lastIndexOf("/src/main/resources/templates/");
  if (spring >= 0) return path.slice(0, spring + "/src/main/resources/templates".length);
  const nearest = path.lastIndexOf("/templates/");
  return nearest >= 0 ? path.slice(0, nearest + "/templates".length) : null;
}

/**
 * The message bundles (`messages`, `i18n/messages`) of Spring's `spring.messages.basename`
 * in `application.properties` / `.yml` text; `messages` when it is not set.
 */
export function messageBasenames(application: string): string[] {
  const flat = /^[ \t]*spring\.messages\.basename[ \t]*[=:][ \t]*(.+)$/m.exec(application);
  const nested = /^[ \t]*messages:[ \t]*\n[ \t]+basename:[ \t]*(.+)$/m.exec(application);
  const value = (flat?.[1] ?? nested?.[1])?.trim().replace(/^["']|["']$/g, "");
  if (!value) return ["messages"];
  const bases = value.split(",").map((b) =>
    b
      .trim()
      .replace(/^classpath\*?:\/?/, "")
      .replace(/\./g, "/"),
  );
  return bases.filter(Boolean);
}

/** Whether the file named `file` belongs to the bundle `base` (`messages.properties`, `messages_zh_CN.properties`). */
export function inBundle(file: string, base: string): boolean {
  const name = base.slice(base.lastIndexOf("/") + 1);
  return file === `${name}.properties` || (file.startsWith(`${name}_`) && file.endsWith(".properties"));
}

/** Extensions Thymeleaf's resolver adds no `.html` suffix to (`ContentTypeUtils.hasRecognizedFileExtension`). */
const RECOGNIZED_EXTENSION = /\.(?:html?|xhtml|xml|rss|atom|js|json|css|txt)$/i;

/** The file a template name resolves to under the templates `root`. */
export function templatePath(root: string, template: string): string {
  return `${root}/${template}${RECOGNIZED_EXTENSION.test(template) ? "" : ".html"}`;
}

const SPRING_TEMPLATES = "/src/main/resources/templates/";
const COMMENT = /<!--[\s\S]*?-->/g;
/** The rest of a `~{…}` followed by `?:`: Thymeleaf's fallback when the fragment does not exist. */
const FALLBACK = /[^}]*\}\s*\?:/y;

/** Whether `application.properties` / `.yml` text sets `spring.thymeleaf.prefix` or `suffix`. */
function customTemplateLocation(application: string): boolean {
  return (
    /spring\.thymeleaf\.(?:prefix|suffix)\b/.test(application) ||
    /thymeleaf:[ \t]*\n(?:[ \t]+.*\n)*?[ \t]+(?:prefix|suffix)[ \t]*:/m.test(application)
  );
}

/** Whether `text` has a fragment `name` selects: `th:fragment`, `th:ref`, `id` or an element named so. */
function definesFragment(text: string, name: string): boolean {
  return (
    fragmentDefinition(text, name) >= 0 ||
    new RegExp(`\\b(?:th:|data-th-)ref\\s*=\\s*["']\\s*${escape(name)}\\s*["']`).test(text) ||
    new RegExp(`<${escape(name)}[\\s>/]`, "i").test(text)
  );
}

/**
 * The template and fragment references in the template `text` at `path` that name no template, or
 * a fragment the named template lacks; `read` gives a file's text, `null` when it does not exist.
 * Only where names resolve as Spring Boot's defaults resolve them (`templates/<name>.html`, no
 * `spring.thymeleaf.prefix` / `suffix` in `application`): elsewhere nothing is reported. A missing
 * template is reported only in the project's own `src/main/resources/templates`: a nested module
 * may get templates from another module or a jar.
 */
export async function unresolvedThymeleafReferences(
  path: string,
  text: string,
  application: string,
  projectRoot: string | null,
  read: (path: string) => Promise<string | null>,
): Promise<Array<Exclude<ThymeleafReference, { kind: "message" }>>> {
  const spring = path.lastIndexOf(SPRING_TEMPLATES);
  if (spring < 0 || customTemplateLocation(application)) return [];
  const root = path.slice(0, spring + SPRING_TEMPLATES.length - 1);
  const ownModule =
    projectRoot !== null && root === `${projectRoot.replace(/\/$/, "")}${SPRING_TEMPLATES.slice(0, -1)}`;
  const comments = [...text.matchAll(COMMENT)].map((m) => [m.index, m.index + m[0].length] as const);
  const refs = thymeleafReferences(text).filter(
    (ref): ref is Exclude<ThymeleafReference, { kind: "message" }> =>
      ref.kind !== "message" &&
      ref.template !== "_" &&
      !ref.template.split("/").some((s) => s === "." || s === "..") &&
      !comments.some(([from, to]) => from <= ref.from && ref.from < to) &&
      !((FALLBACK.lastIndex = ref.to), FALLBACK.test(text)),
  );
  const names = [...new Set(refs.map((ref) => ref.template).filter(Boolean))];
  // The edited template itself is checked against its unsaved text.
  const texts = await Promise.all(
    names.map((name) => (templatePath(root, name) === path ? text : read(templatePath(root, name)))),
  );
  const target = new Map<string, string | null>(names.map((name, i) => [name, texts[i] ?? null]));
  target.set("", text);
  return refs.filter((ref) => {
    const body = target.get(ref.template) ?? null;
    return body === null
      ? ref.kind === "template" && ownModule
      : ref.kind === "fragment" && !definesFragment(body, ref.fragment);
  });
}
