/**
 * Localisation.
 *
 *   t("app.unsaved.body", { count: 3, project: "openidea" })
 *   const t = useT();            // in components: re-renders on locale change
 *
 * Catalogs are flat JSON maps in `platform/locales/<locale>.json`; keys are
 * namespaced by feature (`app.*`, `menu.*`, `vcs.*`…). English is bundled and
 * is the fallback for missing keys; other locales load lazily on `setLocale`.
 * Features may also ship catalogs of their own with `registerMessages`.
 *
 * Most UI text is written in English at the call site instead of under a key.
 * `tx("Sync with OS")` / `useTx()` translate such text through the locale's
 * source-text catalog (`locales/text/<locale>.json`, English → translation);
 * the UI primitives (labels, buttons, menus, dialogs, tooltips) apply it to the
 * strings they are given, and unknown text stays in English.
 *
 * Message syntax (ICU-lite):
 *   - `{name}` parameter (numbers are locale-formatted);
 *   - `{n, plural, =0 {none} one {# file} other {# files}}` — `=N` exact
 *     matches, then CLDR categories via `Intl.PluralRules`, then `other`;
 *     `#` is the formatted number;
 *   - `{g, select, a {…} other {…}}`;
 *   - `{n, number}`.
 *   Branches nest. Unknown parameters are left as written.
 */
import { useCallback, useMemo } from "react";
import { create } from "zustand";
import en from "./locales/en.json";

export type Catalog = Record<string, string>;
export type MessageParams = Record<string, string | number | boolean | null | undefined>;
export type Translate = (key: string, params?: MessageParams) => string;

export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "zh"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const loaders = import.meta.glob<Catalog>(["./locales/*.json", "!./locales/en.json"], { import: "default" });
const textLoaders = import.meta.glob<Catalog>("./locales/text/*.json", { import: "default" });

/** Bundled + loaded catalogs and feature-registered messages, per locale. */
const catalogs = new Map<string, Catalog>([[DEFAULT_LOCALE, en as Catalog]]);
const extra = new Map<string, Catalog>();
const textCatalogs = new Map<string, Catalog>([[DEFAULT_LOCALE, {}]]);

interface I18nState {
  locale: string;
  /** Effective messages for `locale` (without the English fallback). */
  messages: Catalog;
  /** Source-text catalog of `locale`: English text → translation. */
  texts: Catalog;
}

export const useI18n = create<I18nState>(() => ({ locale: DEFAULT_LOCALE, messages: en as Catalog, texts: {} }));

/** Maps settings values / BCP 47 tags to a supported locale (`zh-CN` → `zh`, `system` → browser). */
export function resolveLocale(input: string | null | undefined): Locale {
  let tag = (input ?? "").trim();
  if (!tag || tag === "system" || tag === "auto")
    tag = typeof navigator !== "undefined" ? (navigator.language ?? DEFAULT_LOCALE) : DEFAULT_LOCALE;
  const base = tag.toLowerCase().split(/[-_]/)[0] ?? "";
  return (SUPPORTED_LOCALES as readonly string[]).includes(base) ? (base as Locale) : DEFAULT_LOCALE;
}

let fallbackCache: Catalog | null = null;

function fallback(): Catalog {
  return (fallbackCache ??= merged(DEFAULT_LOCALE));
}

function merged(locale: string): Catalog {
  const base = catalogs.get(locale) ?? {};
  const more = extra.get(locale);
  return more ? { ...base, ...more } : base;
}

async function loadCatalog(locale: string): Promise<Catalog> {
  const cached = catalogs.get(locale);
  if (cached) return cached;
  const load = loaders[`./locales/${locale}.json`];
  const catalog = load ? await load() : {};
  catalogs.set(locale, catalog);
  return catalog;
}

async function loadTexts(locale: string): Promise<Catalog> {
  const cached = textCatalogs.get(locale);
  if (cached) return cached;
  const load = textLoaders[`./locales/text/${locale}.json`];
  const catalog = load ? await load() : {};
  textCatalogs.set(locale, catalog);
  return catalog;
}

let switchToken = 0;

/** Switches the UI locale (loading its catalog on first use). Unsupported tags fall back to English. */
export async function setLocale(input: string | null | undefined): Promise<Locale> {
  const locale = resolveLocale(input);
  const token = ++switchToken;
  try {
    await Promise.all([loadCatalog(locale), loadTexts(locale)]);
  } catch (e) {
    console.warn(`cannot load locale ${locale}`, e);
  }
  if (token === switchToken) {
    useI18n.setState({ locale, messages: merged(locale), texts: textCatalogs.get(locale) ?? {} });
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  }
  return locale;
}

/** Adds messages for a locale (e.g. a feature's own strings). Later registrations win. */
export function registerMessages(locale: string, messages: Catalog): () => void {
  extra.set(locale, { ...extra.get(locale), ...messages });
  const refresh = () => {
    fallbackCache = null;
    const s = useI18n.getState();
    if (s.locale === locale || locale === DEFAULT_LOCALE) useI18n.setState({ messages: merged(s.locale) });
  };
  refresh();
  return () => {
    const current = { ...extra.get(locale) };
    for (const k of Object.keys(messages)) if (current[k] === messages[k]) delete current[k];
    extra.set(locale, current);
    refresh();
  };
}

/** The raw message for `key` in the active locale, falling back to English; `undefined` if unknown. */
export function lookup(key: string, state: Pick<I18nState, "messages"> = useI18n.getState()): string | undefined {
  return state.messages[key] ?? fallback()[key];
}

/** Translates `key`; returns the key itself when no catalog has it. */
export function t(key: string, params?: MessageParams): string {
  const s = useI18n.getState();
  return translateWith(s, key, params);
}

function translateWith(s: Pick<I18nState, "locale" | "messages">, key: string, params?: MessageParams): string {
  const message = lookup(key, s);
  if (message === undefined) return key;
  return formatMessage(message, params, s.locale);
}

/** `t` bound to the current locale; components re-render when it changes. */
export function useT(): Translate {
  const locale = useI18n((s) => s.locale);
  const messages = useI18n((s) => s.messages);
  return useCallback((key, params) => translateWith({ locale, messages }, key, params), [locale, messages]);
}

/**
 * Translates English UI text through the source-text catalog; unknown text is returned as is.
 *
 * As a tag it translates text built at runtime: `` tx`Remove data source '${name}'?` ``
 * looks up `"Remove data source '{name}'?"` (whatever the placeholder names) and fills
 * in the values, each translated as text when the catalog has it. The result is
 * remembered, so the UI primitives, which pass their strings through `tx` as they
 * render, translate it again after a locale change or once the catalog has loaded.
 */
export function tx(strings: TemplateStringsArray, ...values: unknown[]): string;
export function tx(text: string): string;
export function tx(text: string | undefined): string | undefined;
export function tx(text: string | TemplateStringsArray | undefined, ...values: unknown[]): string | undefined {
  return translateSource(useI18n.getState().texts, text, values);
}

/** `tx` bound to the current locale; components re-render when it changes. */
export function useTx(): typeof tx {
  const texts = useI18n((s) => s.texts);
  return useMemo(() => {
    function bound(strings: TemplateStringsArray, ...values: unknown[]): string;
    function bound(text: string): string;
    function bound(text: string | undefined): string | undefined;
    function bound(text: string | TemplateStringsArray | undefined, ...values: unknown[]) {
      return translateSource(texts, text, values);
    }
    return bound;
  }, [texts]);
}

function translateSource(texts: Catalog, text: string | TemplateStringsArray | undefined, values: unknown[]) {
  // A tag without `${}` spells out its whole text, which is looked up as written.
  if (text !== undefined && typeof text !== "string" && !values.length) text = text[0]!;
  if (text === undefined || typeof text === "string") return text && (texts[text] ?? rebuild(texts, text) ?? text);
  return buildText(texts, { strings: text, values });
}

/** Text built by a `tx` tag: the template's literal parts and the interpolated values. */
type Built = { strings: readonly string[]; values: readonly unknown[] };

const MAX_BUILT = 10_000;
/** Text that `tx` tags returned (in English and translated), most recently built last. */
const built = new Map<string, Built>();

function remember(text: string, b: Built) {
  built.delete(text);
  built.set(text, b);
  if (built.size > MAX_BUILT) built.delete(built.keys().next().value!);
}

type Shape = { names: string[]; translation: string };

const shapeCache = new WeakMap<Catalog, Map<string, Shape>>();

/** Source-text templates by their literal parts: `"Run '{name}'"` under `"Run '{}'"`. */
function shapesOf(texts: Catalog): Map<string, Shape> {
  let shapes = shapeCache.get(texts);
  if (shapes) return shapes;
  shapes = new Map();
  for (const [source, translation] of Object.entries(texts)) {
    const names = [...source.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    if (names.length) shapes.set(source.replace(/\{\w+\}/g, "{}"), { names, translation });
  }
  shapeCache.set(texts, shapes);
  return shapes;
}

const interleave = (strings: readonly string[], parts: readonly string[]) =>
  strings.reduce((out, s, i) => out + parts[i - 1] + s);

function formatBuilt(texts: Catalog, { strings, values }: Built): string {
  const parts = values.map((v) => (typeof v === "string" ? (texts[v] ?? rebuild(texts, v) ?? v) : String(v)));
  const shape = shapesOf(texts).get(strings.join("{}"));
  if (!shape) return interleave(strings, parts);
  const params: MessageParams = {};
  shape.names.forEach((name, i) => (params[name] = parts[i]));
  return formatMessage(shape.translation, params);
}

function buildText(texts: Catalog, b: Built): string {
  const english = interleave(b.strings, b.values.map(String));
  remember(english, b);
  const text = formatBuilt(texts, b);
  if (text !== english) remember(text, b);
  return text;
}

/** Text that a `tx` tag built, in the locale of `texts`; `undefined` for any other text. */
function rebuild(texts: Catalog, text: string): string | undefined {
  const b = built.get(text);
  return b && formatBuilt(texts, b);
}

type Template = { pattern: RegExp; names: string[]; translation: string; literal: number };

const templateCache = new WeakMap<Catalog, Template[]>();

/** Source-text entries with `{name}` placeholders, e.g. `"{name} is not installed"`. */
function templatesOf(texts: Catalog): Template[] {
  let templates = templateCache.get(texts);
  if (templates) return templates;
  templates = [];
  for (const [source, translation] of Object.entries(texts)) {
    const names: string[] = [];
    const parts = source.split(/\{(\w+)\}/);
    if (parts.length < 2) continue;
    const pattern = parts
      .map((part, i) => (i % 2 ? (names.push(part), "(.+?)") : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("");
    templates.push({
      pattern: new RegExp(`^${pattern}$`),
      names,
      translation,
      literal: source.length - names.join("").length,
    });
  }
  // Most specific first: `Language server '{name}' is not installed` before `{name} is not installed`.
  templates.sort((a, b) => b.literal - a.literal);
  templateCache.set(texts, templates);
  return templates;
}

function translateText(texts: Catalog, text: string): string {
  const exact = texts[text] ?? rebuild(texts, text);
  if (exact !== undefined) return exact;
  for (const { pattern, names, translation } of templatesOf(texts)) {
    const m = pattern.exec(text);
    if (!m) continue;
    const params: MessageParams = {};
    names.forEach((name, i) => (params[name] = texts[m[i + 1]!] ?? m[i + 1]));
    return formatMessage(translation, params);
  }
  return text;
}

/**
 * `tx` for text built at runtime (notification titles): also matches source-text
 * templates such as `"{name} failed"`, translating the substituted parts as text.
 */
export function txTemplate(text: string): string {
  return translateText(useI18n.getState().texts, text);
}

/** `txTemplate` bound to the current locale; components re-render when it changes. */
export function useTxTemplate(): (text: string) => string {
  const texts = useI18n((s) => s.texts);
  return useCallback((text: string) => translateText(texts, text), [texts]);
}

/** All keys with `prefix`, across the active catalog and the English fallback. */
export function keysWithPrefix(prefix: string): string[] {
  const keys = new Set<string>();
  for (const k of Object.keys(fallback())) if (k.startsWith(prefix)) keys.add(k);
  for (const k of Object.keys(useI18n.getState().messages)) if (k.startsWith(prefix)) keys.add(k);
  return [...keys];
}

// ---------------------------------------------------------------------------
// ICU-lite formatter

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function plural(locale: string): Intl.PluralRules {
  let r = pluralRules.get(locale);
  if (!r) pluralRules.set(locale, (r = new Intl.PluralRules(locale)));
  return r;
}

function formatNumber(n: number, locale: string): string {
  let f = numberFormats.get(locale);
  if (!f) numberFormats.set(locale, (f = new Intl.NumberFormat(locale)));
  return f.format(n);
}

function display(value: MessageParams[string], locale: string): string {
  if (typeof value === "number") return formatNumber(value, locale);
  return String(value);
}

/** Formats an ICU-lite message. Malformed messages are returned unformatted. */
export function formatMessage(message: string, params: MessageParams = {}, locale = DEFAULT_LOCALE): string {
  if (!message.includes("{")) return message;
  try {
    return formatStrict(message, params, locale);
  } catch {
    return message;
  }
}

/** Whether `message` is well-formed ICU-lite (used by catalog tests). */
export function isValidMessage(message: string): boolean {
  try {
    formatStrict(message, {}, DEFAULT_LOCALE);
    return true;
  } catch {
    return false;
  }
}

function formatStrict(message: string, params: MessageParams, locale: string): string {
  let i = 0;
  const src = message;

  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const readUntil = (stops: string): string => {
    const start = i;
    while (i < src.length && !stops.includes(src[i]!)) i++;
    return src.slice(start, i);
  };

  // Text until an unmatched `}` (left unconsumed) or the end.
  function text(hash: string | undefined): string {
    let out = "";
    while (i < src.length) {
      const c = src[i]!;
      if (c === "}") return out;
      if (c === "{") out += argument(hash);
      else if (c === "#" && hash !== undefined) {
        out += hash;
        i++;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }

  function argument(hash: string | undefined): string {
    const start = i++;
    skipWs();
    const name = readUntil(",}").trim();
    if (src[i] === "}") {
      i++;
      const v = params[name];
      return v === undefined || v === null ? src.slice(start, i) : display(v, locale);
    }
    if (src[i] !== ",") throw new SyntaxError("unterminated argument");
    i++;
    skipWs();
    const type = readUntil(",}").trim();
    const value = params[name];
    if (src[i] === "}") {
      i++;
      if (value === undefined || value === null) return src.slice(start, i);
      return type === "number" && typeof value === "number" ? formatNumber(value, locale) : display(value, locale);
    }
    i++; // ','
    if (type !== "plural" && type !== "select") throw new SyntaxError(`unknown argument type ${type}`);
    const n = Number(value);
    const branchHash = type === "plural" ? (Number.isFinite(n) ? formatNumber(n, locale) : String(value)) : hash;
    const options = new Map<string, string>();
    for (;;) {
      skipWs();
      if (i >= src.length) throw new SyntaxError("unterminated options");
      if (src[i] === "}") {
        i++;
        break;
      }
      const selector = readUntil("{ \t\n\r}").trim();
      skipWs();
      if (src[i] !== "{" || !selector) throw new SyntaxError("expected option body");
      i++;
      const body = text(branchHash);
      if (src[i] !== "}") throw new SyntaxError("unterminated option");
      i++;
      options.set(selector, body);
    }
    if (value === undefined || value === null) return options.get("other") ?? "";
    if (type === "plural") {
      return (
        options.get(`=${n}`) ??
        options.get(Number.isFinite(n) ? plural(locale).select(n) : "other") ??
        options.get("other") ??
        ""
      );
    }
    return options.get(String(value)) ?? options.get("other") ?? "";
  }

  let out = "";
  while (i < src.length) {
    out += text(undefined);
    if (i < src.length) out += src[i++]; // stray `}`
  }
  return out;
}

/** Tests only: drop loaded catalogs and registered messages. */
export function _resetI18nForTests() {
  for (const k of [...catalogs.keys()]) if (k !== DEFAULT_LOCALE) catalogs.delete(k);
  extra.clear();
  fallbackCache = null;
  switchToken++;
  useI18n.setState({ locale: DEFAULT_LOCALE, messages: en as Catalog, texts: {} });
}
