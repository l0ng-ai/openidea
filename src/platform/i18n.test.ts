import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetI18nForTests,
  formatMessage,
  isValidMessage,
  keysWithPrefix,
  registerMessages,
  resolveLocale,
  setLocale,
  SUPPORTED_LOCALES,
  t,
  tx,
  txTemplate,
  useI18n,
} from "./i18n";
import en from "./locales/en.json";

afterEach(() => _resetI18nForTests());

describe("formatMessage", () => {
  it("substitutes parameters and leaves unknown ones", () => {
    expect(formatMessage("Open {name}", { name: "openidea" })).toBe("Open openidea");
    expect(formatMessage("Open {name} in {where}", { name: "openidea" })).toBe("Open openidea in {where}");
    expect(formatMessage("plain text")).toBe("plain text");
  });

  it("formats numbers per locale", () => {
    expect(formatMessage("{n} files", { n: 12345 }, "en")).toBe("12,345 files");
    expect(formatMessage("{n, number}", { n: 1234.5 }, "en")).toBe("1,234.5");
  });

  it("selects plural categories, exact matches first", () => {
    const m = "{count, plural, =0 {No files} one {# file} other {# files}}";
    expect(formatMessage(m, { count: 0 })).toBe("No files");
    expect(formatMessage(m, { count: 1 })).toBe("1 file");
    expect(formatMessage(m, { count: 2 })).toBe("2 files");
    expect(formatMessage(m, { count: 1000 })).toBe("1,000 files");
  });

  it("uses CLDR rules of the locale (Chinese has only `other`)", () => {
    const m = "{count, plural, one {# one} other {# other}}";
    expect(formatMessage(m, { count: 1 }, "zh")).toBe("1 other");
    expect(formatMessage(m, { count: 1 }, "en")).toBe("1 one");
  });

  it("uses CLDR rules of the locale (French zero is singular, `many` falls back to `other`)", () => {
    const m = "{count, plural, one {# fichier} other {# fichiers}}";
    expect(formatMessage(m, { count: 0 }, "fr")).toBe("0 fichier");
    expect(formatMessage(m, { count: 2 }, "fr")).toBe("2 fichiers");
    expect(formatMessage(m, { count: 1_000_000 }, "fr")).toBe(
      `${new Intl.NumberFormat("fr").format(1_000_000)} fichiers`,
    );
  });

  it("supports select and nesting", () => {
    const m = "{os, select, macos {Finder} windows {Explorer} other {Files}}";
    expect(formatMessage(m, { os: "macos" })).toBe("Finder");
    expect(formatMessage(m, { os: "linux" })).toBe("Files");
    const nested = "{count, plural, one {{who} has # file} other {{who} has # files}}";
    expect(formatMessage(nested, { count: 3, who: "Ann" })).toBe("Ann has 3 files");
    const deep = "{os, select, macos {{count, plural, one {# window} other {# windows}}} other {#}}";
    expect(formatMessage(deep, { os: "macos", count: 2 })).toBe("2 windows");
  });

  it("falls back to `other` when the parameter is missing", () => {
    expect(formatMessage("{n, plural, one {one} other {many}}")).toBe("many");
  });

  it("returns malformed messages unformatted", () => {
    expect(formatMessage("{n, plural, one {x}", { n: 1 })).toBe("{n, plural, one {x}");
    expect(formatMessage("{n, weird, a {b}}", { n: 1 })).toBe("{n, weird, a {b}}");
    expect(isValidMessage("{n, plural, one {x}")).toBe(false);
    expect(isValidMessage("{n, plural, one {x} other {y}}")).toBe(true);
  });
});

describe("t / locales", () => {
  it("resolves locale tags", () => {
    expect(resolveLocale("zh-CN")).toBe("zh");
    expect(resolveLocale("zh_Hans")).toBe("zh");
    expect(resolveLocale("ko-KR")).toBe("ko");
    expect(resolveLocale("pt-BR")).toBe("pt");
    expect(resolveLocale("pt_PT")).toBe("pt");
    expect(resolveLocale("EN-us")).toBe("en");
    expect(resolveLocale("fr")).toBe("fr");
    expect(resolveLocale("fr-CA")).toBe("fr");
    expect(resolveLocale("pl_PL")).toBe("pl");
    expect(resolveLocale("pl-PL")).toBe("pl");
    expect(resolveLocale("es-MX")).toBe("es");
    expect(resolveLocale("es_MX")).toBe("es");
    expect(resolveLocale("xx")).toBe("en");
    expect(resolveLocale(undefined)).toBe(resolveLocale(navigator.language));
  });

  it("translates with English fallback, then the key itself", async () => {
    expect(t("common.cancel")).toBe("Cancel");
    await setLocale("zh");
    expect(useI18n.getState().locale).toBe("zh");
    expect(t("common.cancel")).toBe("取消");
    registerMessages("en", { "test.onlyEnglish": "Only English" });
    expect(t("test.onlyEnglish")).toBe("Only English");
    expect(t("test.missing.key")).toBe("test.missing.key");
  });

  it("applies params and plurals in the active locale", async () => {
    expect(t("app.unsaved.body", { count: 1, project: "openidea" })).toBe(
      "1 file has unsaved changes in openidea. Save before closing?",
    );
    await setLocale("zh-CN");
    expect(t("app.keymap.count", { count: 1 })).toBe("1 个快捷键");
    await setLocale("pt-BR");
    expect(t("app.keymap.count", { count: 1 })).toBe("1 atalho");
    expect(t("app.keymap.count", { count: 5 })).toBe("5 atalhos");
  });

  it("switches to Korean", async () => {
    await setLocale("ko-KR");
    expect(useI18n.getState().locale).toBe("ko");
    expect(t("common.cancel")).toBe("취소");
    expect(tx("Cancel")).toBe("취소");
  });

  it("falls back to English for unsupported locales", async () => {
    await setLocale("xx");
    expect(useI18n.getState().locale).toBe("en");
  });

  it("registerMessages adds and removes feature strings", async () => {
    const off = registerMessages("zh", { "feature.hello": "你好" });
    registerMessages("en", { "feature.hello": "Hello" });
    expect(t("feature.hello")).toBe("Hello");
    await setLocale("zh");
    expect(t("feature.hello")).toBe("你好");
    off();
    expect(t("feature.hello")).toBe("Hello");
  });

  it("translates source text through the locale's text catalog", async () => {
    await setLocale("en");
    expect(tx("Sync with OS")).toBe("Sync with OS");
    await setLocale("zh");
    expect(tx("Sync with OS")).toBe("与操作系统同步");
    expect(tx("Some text nobody translated")).toBe("Some text nobody translated");
    expect(tx(undefined)).toBeUndefined();
  });

  it("translates a tx tag without values like the same text as a string", async () => {
    await setLocale("zh");
    expect(tx`Sync with OS`).toBe("与操作系统同步");
    expect(tx`Sync with OS`).toBe(tx("Sync with OS"));
    expect(tx`Some text nobody translated`).toBe("Some text nobody translated");
  });

  it("matches source-text templates, translating the substituted text", async () => {
    expect(txTemplate("Push failed")).toBe("Push failed");
    await setLocale("zh");
    expect(txTemplate("ruff is not installed")).toBe("ruff 未安装");
    expect(txTemplate("Language server 'gopls' is not installed")).toBe("语言服务器 'gopls' 未安装");
    expect(txTemplate("Retry failed")).toBe(`${tx("Retry")}失败`);
    expect(txTemplate("Sync with OS")).toBe("与操作系统同步");
    expect(txTemplate("Something else entirely")).toBe("Something else entirely");
    expect(
      txTemplate(
        "The PHP language server can't rename this symbol; renaming only the plugin's indexed names would leave it half renamed",
      ),
    ).toBe("语言服务器无法重命名此符号（PHP）；仅重命名插件索引的名称会导致重命名不完整");
    expect(
      txTemplate(
        "The Ruby language server can't rename this symbol; renaming only the plugin's indexed names would leave it half renamed",
      ),
    ).toBe("语言服务器无法重命名此符号（Ruby 语言）；仅重命名插件索引的名称会导致重命名不完整");
  });

  it("translates text built by the tx tag, again after the locale changes", async () => {
    await setLocale("en");
    const name = "orders";
    const built = tx`Run '${name}'`;
    expect(built).toBe("Run 'orders'");
    expect(tx`Unknown ${name} text`).toBe("Unknown orders text");
    await setLocale("zh");
    // Built before the catalog loaded: primitives passing it through `tx` translate it.
    expect(tx(built)).toBe("运行 'orders'");
    expect(txTemplate(built)).toBe("运行 'orders'");
    const zh = tx`Run '${name}'`;
    expect(zh).toBe("运行 'orders'");
    // Substituted text is translated when the catalog has it.
    expect(tx`Run '${"Retry"}'`).toBe(`运行 '${tx("Retry")}'`);
    // Values are inserted as they are, braces included.
    expect(tx`Drop ${"stash@{0}"}? This cannot be undone.`).toBe("是否丢弃 stash@{0}？此操作无法撤消。");
    await setLocale("en");
    expect(tx(zh)).toBe("Run 'orders'");
  });

  it("loads the Portuguese catalogs", async () => {
    await setLocale("pt-BR");
    expect(useI18n.getState().locale).toBe("pt");
    expect(t("common.cancel")).toBe("Cancelar");
    expect(t("app.keymap.count", { count: 1 })).toBe("1 atalho");
    expect(t("app.keymap.count", { count: 5 })).toBe("5 atalhos");
  });

  it("loads the French catalogs", async () => {
    await setLocale("fr-FR");
    expect(useI18n.getState().locale).toBe("fr");
    expect(t("common.cancel")).toBe("Annuler");
    expect(t("app.keymap.count", { count: 0 })).toBe("0 raccourci");
    expect(tx("Sync with OS")).toBe("Synchroniser avec le système");
    expect(tx`Run '${"orders"}'`).toBe("Exécuter 'orders'");
    expect(txTemplate("ruff is not installed")).toBe("ruff n'est pas installé");
  });

  it("loads the Polish catalogs", async () => {
    await setLocale("pl-PL");
    expect(useI18n.getState().locale).toBe("pl");
    expect(t("common.cancel")).toBe("Anuluj");
    expect(t("app.keymap.count", { count: 1 })).toBe("1 skrót");
    expect(t("app.keymap.count", { count: 5 })).toBe("5 skrótów");
  });

  it("loads the Spanish catalogs", async () => {
    await setLocale("es-MX");
    expect(useI18n.getState().locale).toBe("es");
    expect(t("common.cancel")).toBe("Cancelar");
    expect(t("app.keymap.count", { count: 1 })).toBe("1 atajo");
    expect(t("app.keymap.count", { count: 5 })).toBe("5 atajos");
  });

  it("lists keys by prefix", () => {
    const keys = keysWithPrefix("menu.");
    expect(keys).toContain("menu.file.save");
    expect(keys.every((k) => k.startsWith("menu."))).toBe(true);
  });
});

describe("catalogs", () => {
  type Catalog = Record<string, string>;
  const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "locales");
  /** Catalog files of a folder as `{ locale: catalog }`, read from disk so that a new file is always seen. */
  const readCatalogs = (dir: string) =>
    Object.fromEntries(
      readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => [file.slice(0, -5), JSON.parse(readFileSync(join(dir, file), "utf8")) as Catalog]),
    );

  const { en: _en, ...translations } = readCatalogs(LOCALES_DIR);
  const texts = readCatalogs(join(LOCALES_DIR, "text"));
  const catalogs: Record<string, Catalog> = { en, ...translations };
  /** Must have every key; the other locales show English for keys they lack. */
  const COMPLETE = ["zh"];
  /** Written in another script, so a text equal to its English source was not translated. */
  const OWN_SCRIPT = new Set(["zh", "ko"]);
  /** Product names intentionally kept as written in every locale. */
  const SAME_AS_ENGLISH = new Set([
    "Docker",
    "JUnit",
    "⌘Enter",
    "Fork",
    "Shell",
    "Java",
    "Python",
    "C/C++",
    "C#",
    "Go",
    "Rust",
    "Kotlin",
    "PHP",
    "SQL",
    "JavaScript",
    "TypeScript",
    "HTML",
    "CSS",
    "JSON",
    "YAML",
    "XML",
    "Maven",
    "Gradle",
    "npm",
    "pnpm",
    "Yarn",
    "Cargo",
    "CMake",
  ]);
  const translated = SUPPORTED_LOCALES.filter((locale) => locale !== "en").sort();

  it("exist for exactly the supported locales", () => {
    expect(translated.length).toBeGreaterThan(0);
    expect(Object.keys(translations).sort()).toEqual(translated);
    expect(Object.keys(texts).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it("translate source text into non-empty text", () => {
    for (const [locale, catalog] of Object.entries(texts))
      for (const [source, text] of Object.entries(catalog)) expect(text.trim(), `${locale}:${source}`).not.toBe("");
  });

  it("translate source text into text different from English, in locales with another script", () => {
    for (const [locale, catalog] of Object.entries(texts))
      if (OWN_SCRIPT.has(locale))
        for (const [source, text] of Object.entries(catalog))
          if (!SAME_AS_ENGLISH.has(source)) expect(text, `${locale}:${source}`).not.toBe(source);
  });

  it("keep the placeholders of source-text templates", () => {
    const names = (m: string) => [...m.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
    for (const [locale, catalog] of Object.entries(texts))
      for (const [source, text] of Object.entries(catalog))
        expect(names(text), `${locale}:${source}`).toEqual(names(source));
  });

  it.each(COMPLETE)("have the same keys as English (%s)", (locale) => {
    expect(Object.keys(translations[locale]!).sort()).toEqual(Object.keys(en).sort());
  });

  it("have no keys English lacks", () => {
    for (const [locale, catalog] of Object.entries(translations))
      expect(
        Object.keys(catalog).filter((key) => !Object.hasOwn(en, key)),
        locale,
      ).toEqual([]);
  });

  it("contain only well-formed messages", () => {
    for (const [locale, catalog] of Object.entries(catalogs))
      for (const [key, message] of Object.entries(catalog))
        expect(isValidMessage(message), `${locale}:${key}`).toBe(true);
  });

  it("use the same parameters across locales", () => {
    const params = (m: string) => [...m.matchAll(/\{\s*([a-z]\w*)\s*[,}]/g)].map((x) => x[1]).sort();
    for (const [locale, catalog] of Object.entries(translations))
      for (const [key, message] of Object.entries(catalog))
        expect(params(message), `${locale}:${key}`).toEqual(params((en as Record<string, string>)[key] ?? ""));
  });
});
