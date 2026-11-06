/**
 * Editor › Color Scheme: scheme chooser, the IDEA attribute tree (General,
 * Language Defaults, languages) with a foreground / background / bold /
 * italic / effects editor, and a live preview. Edits are staged in
 * `editor.colorOverrides[scheme][attribute]`; `editor/core` injects them.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button, Checkbox, Input, Tree, type SelectOption, T } from "@/ui";
import { fontWeightVars, type CustomColorSchemes, type TextAttributesOverride } from "@/platform/editorSettings";
import {
  ATTRIBUTES,
  SCHEMES,
  overrideDeclarations,
  effectiveScheme,
  resolvedSchemeTokens,
  resolvedAttribute,
  CLEAR_COLOR,
  listSchemes,
  customSchemes,
  type AttributeDef,
} from "@/platform/colorScheme";
import { HEX_COLOR } from "../../model/schema";
import { Row, Select } from "../../components/Form";
import { useSetting } from "../../components/context";
import { editorPage } from "./kit";
import type { PageSpec } from "../spec";
import styles from "./Editor.module.css";
import { executeAction, registerActions } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { ask, confirm, showError } from "@/workbench/messages";
import { parseIcls, importScheme, deleteScheme, exportIcls } from "@/platform/icls";
import { tx } from "@/platform/i18n";
import { selectPage } from "../../model/staging";

type Overrides = Record<string, Record<string, TextAttributesOverride>>;

interface Node {
  key: string;
  label: string;
  attr?: AttributeDef;
  children?: Node[];
}

/** Tree segments of an attribute: its scope path plus any "›" groups in its display name. */
function attrSegs(attr: AttributeDef): string[] {
  const parts = attr.name.split(" › ");
  return [...attr.path, ...parts.slice(0, -1)];
}

function buildTree(): Node[] {
  const roots: Node[] = [];
  for (const attr of ATTRIBUTES) {
    const parts = attr.name.split(" › ");
    let level = roots;
    let key = "";
    for (const seg of attrSegs(attr)) {
      key += `/${seg}`;
      let n = level.find((x) => x.key === key);
      if (!n) level.push((n = { key, label: seg, children: [] }));
      level = n.children!;
    }
    level.push({ key: attr.id, label: parts.at(-1)!, attr });
  }
  return roots;
}

const TREE = buildTree();

/** Roots of one page's attribute tree, in JetBrains fashion: scopes are pages, not tree panes. */
function pageTree(scopes: readonly string[]): Node[] {
  return TREE.filter((n) => scopes.includes(n.label));
}

function firstLeafId(nodes: readonly Node[]): string {
  const n = nodes[0]!;
  return n.attr ? n.attr.id : firstLeafId(n.children!);
}

function treeIds(nodes: readonly Node[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.attr) out.add(n.attr.id);
    if (n.children) treeIds(n.children, out);
  }
  return out;
}

/**
 * CSS custom properties of a scheme plus pending overrides (for the preview); with
 * `language`, that language's own colours on top, as its editors show them.
 */
function previewVars(
  id: string,
  o: Record<string, TextAttributesOverride> | undefined,
  customs: CustomColorSchemes,
  language?: string,
): CSSProperties {
  const vars: Record<string, string> = {};
  const tokens = resolvedSchemeTokens(id, customs);
  for (const [k, v] of tokens)
    if (
      k.startsWith("--syn-") ||
      k.startsWith("--fg-") ||
      k.startsWith("--bg-") ||
      k.startsWith("--border-") ||
      k === "--caret"
    )
      vars[k] = v;
  vars["--bg-editor"] = tokens.get("--bg-editor") ?? tokens.get("--bg-island") ?? "";
  for (const [key, value] of overrideDeclarations(o)) vars[key] = value;
  if (language) {
    for (const [key, value] of overrideDeclarations(customs[id]?.attributes, language)) vars[key] = value;
    for (const [key, value] of overrideDeclarations(o, language)) vars[key] = value;
  }
  return vars as CSSProperties;
}

/** Text styled like an attribute in the preview. */
function tokenStyle(attr: AttributeDef | undefined): CSSProperties {
  if (!attr?.token)
    return {
      ...(attr?.fg ? { color: `var(${attr.fg})` } : null),
      ...(attr?.bg ? { backgroundColor: `var(${attr.bg})` } : null),
    };
  if (attr.italicOnly)
    return { fontStyle: `var(--syn-${attr.token}-italic, ${attr.defaultItalic === false ? "normal" : "italic"})` };
  const t = attr.token;
  return {
    color: `var(--syn-${t})`,
    fontWeight: `var(--syn-${t}-bold, inherit)` as CSSProperties["fontWeight"],
    fontStyle: `var(--syn-${t}-italic, ${t === "comment" ? "var(--syn-comment-style)" : t === "doc-comment" || t === "docstring" ? "italic" : "inherit"})`,
    backgroundColor: `var(--syn-${t}-bg, transparent)`,
    textDecoration: `var(--syn-${t}-effect, none)`,
    // WebKit takes a decoration with a style or colour only through the prefixed property.
    ...({ WebkitTextDecoration: `var(--syn-${t}-effect, none)` } as CSSProperties),
  };
}

const A = (id: string) => ATTRIBUTES.find((a) => a.id === id);

type Seg = [string, string?];
interface CodeSample {
  code: Seg[][];
  /** Line shown with the caret-row background. */
  caret?: number;
}

/** One sample per page, each covering as much of that scope's token set as possible. */
const SAMPLES: Record<string, CodeSample> = {
  General: {
    code: [
      [["# General: text, gutter, hints and matches", "lineComment"]],
      [
        ["TODO", "todo"],
        [" check the wave decorations below", "text"],
      ],
      [
        ["erroneous", "error"],
        ["   ", "text"],
        ["suspicious", "warning"],
        ["   ", "text"],
        ["could be const", "weakWarning"],
        ["   ", "text"],
        ["legacyCall", "unused"],
      ],
      [
        ["bad\u203dchar", "invalid"],
        ["   \u00b7   ", "whitespaces"],
        ["\u2192 indent guides \u2192", "indentGuide"],
      ],
      [
        ["const", "inlay"],
        [" name", "text"],
        [" = ", "operator"],
        ["value", "text"],
        ["   ", "text"],
        ["\u2026", "folded"],
        [" folded region ", "folded"],
        ["\u2026", "folded"],
      ],
      [
        ["search hit ", "text"],
        ["token", "searchResult"],
        [" and current ", "text"],
        ["token", "searchResultCurrent"],
      ],
      [
        ["matched ", "text"],
        ["()", "matchedBrace"],
        ["   identifier under caret ", "text"],
        ["name", "identifierUnderCaret"],
        [" / ", "text"],
        ["name", "identifierUnderCaretWrite"],
      ],
    ],
  },
  Debugger: {
    code: [
      [["# Debugger: inline values and breakpoint rows", "lineComment"]],
      [
        ["len", "inlineValue"],
        [" = ", "text"],
        ["3", "text"],
        ["    ", "text"],
        ["name", "inlineValue"],
        [" = ", "text"],
        ['"world"', "string"],
      ],
      [
        ["return", "keyword"],
        [" len(text)", "text"],
      ],
    ],
    caret: 2,
  },
  "Language Defaults": {
    code: [
      [["# Language Defaults", "lineComment"]],
      [["@Entity", "metadata"]],
      [
        ["class ", "keyword"],
        ["Session", "className"],
        [" implements ", "keyword"],
        ["Runnable", "className"],
        [" {", "operator"],
      ],
      [
        ["  /**", "docComment"],
        [" doc comment ", "docComment"],
        ["@param", "docComment"],
        [" id", "docComment"],
        [" */", "docComment"],
      ],
      [
        ["  static", "staticSymbol"],
        [" MAX", "constant"],
        [" = ", "operator"],
        ["0xff", "number"],
        [";", "operator"],
      ],
      [
        ["  field", "field"],
        [" = ", "operator"],
        ['"a', "string"],
        ["\\n", "escape"],
        ["\\t", "escape"],
        ["z", "string"],
        ['\\"', "escape"],
        ['"', "string"],
        [";", "operator"],
      ],
      [
        ["  def ", "keyword"],
        ["greet", "functionDeclaration"],
        ["(", "operator"],
        ["name", "parameter"],
        [", ", "operator"],
        ["GLOBAL", "globalVariable"],
        ["):", "operator"],
      ],
      [
        ["    ", "text"],
        ["greet", "functionCall"],
        ["(", "operator"],
        ["predefined", "predefined"],
        [", ", "operator"],
        ["local", "identifier"],
        [")", "operator"],
      ],
      [
        ["    x", "identifier"],
        [" = ", "operator"],
        ["[", "bracket1"],
        ["(", "bracket2"],
        ["{", "bracket3"],
        ["1", "number"],
        ["}", "bracket3"],
        [")", "bracket2"],
        ["]", "bracket1"],
        [";", "operator"],
      ],
      [
        ["    s1", "semantic1"],
        [" s2", "semantic2"],
        [" s3", "semantic3"],
        [" s4", "semantic4"],
        [" s5", "semantic5"],
      ],
      [
        ["    <", "operator"],
        ["div", "markupTag"],
        [" ", "text"],
        ["class", "markupAttribute"],
        ["=", "operator"],
        ['"row"', "string"],
        [">", "operator"],
        ["\u2026", "text"],
        ["</", "operator"],
        ["div", "markupTag"],
        [">", "operator"],
      ],
      [["}", "operator"]],
    ],
  },
  Python: {
    caret: 7,
    code: [
      [["# Python", "lineComment"]],
      [
        ["import ", "keyword"],
        ["os", "pyStaticSymbol"],
      ],
      [
        ["MAX_RETRIES", "pyConstant"],
        [" = ", "operator"],
        ["3", "number"],
      ],
      [
        ["counter", "pyGlobalVariable"],
        [" = ", "operator"],
        ["0", "number"],
      ],
      [["@dataclass", "pyDecorator"]],
      [
        ["class ", "keyword"],
        ["Greeter", "className"],
        ["[", "pyBrackets"],
        ["T", "pyTypeParameter"],
        ["]", "pyBrackets"],
        [":", "operator"],
      ],
      [
        ["    flag", "pyClassAttribute"],
        [": ", "text"],
        ["bool", "pyAnnotation"],
        [" = ", "operator"],
        ["True", "pyBuiltin"],
      ],
      [
        ["    def ", "keyword"],
        ["__init__", "pyPredefinedDefinition"],
        ["(", "pyParentheses"],
        ["self", "pySelf"],
        [", ", "operator"],
        ["name", "parameter"],
        [")", "pyParentheses"],
        [" -> ", "operator"],
        ["str", "pyAnnotation"],
        [":", "operator"],
      ],
      [
        ["        ", "text"],
        ["self", "pySelf"],
        [".", "operator"],
        ["greeting", "pyInstanceAttribute"],
        [" = ", "operator"],
        ["name", "parameter"],
      ],
      [["@property", "pyDecorator"]],
      [
        ["    def ", "keyword"],
        ["greeting", "pyProperty"],
        ["(", "pyParentheses"],
        ["self", "pySelf"],
        [")", "pyParentheses"],
        [":", "operator"],
      ],
      [
        ["        return ", "keyword"],
        ["f", "pyFString"],
        ['"hi {', "pyFString"],
        ["name", "pyLocalVariable"],
        [":>10", "pyFormat"],
        ['}"', "pyFString"],
      ],
      [
        ["    def ", "keyword"],
        ["_wrap", "pyNestedFunction"],
        ["(", "pyParentheses"],
        [")", "pyParentheses"],
        [":", "operator"],
      ],
      [
        ["        data", "pyLocalVariable"],
        [" = ", "operator"],
        ["b", "pyBytes"],
        ['"\\x00"', "pyBytes"],
      ],
      [
        ["        return ", "keyword"],
        ["sys", "pyStaticSymbol"],
        [".", "operator"],
        ["maxsize", "pyPredefinedUsage"],
      ],
      [
        ["print", "pyPredefinedUsage"],
        ["(", "pyParentheses"],
        ["greeter", "pyLocalVariable"],
        [".", "operator"],
        ["greeting", "pyMethodCall"],
        [", ", "operator"],
        ["end", "pyKeywordArg"],
        ["=", "operator"],
        ['""', "string"],
        [")", "pyParentheses"],
      ],
      [['    """Sample docstring."""', "pyDocstring"]],
    ],
  },
  Markdown: {
    code: [
      [["# Heading level one", "mdHeading"]],
      [["## Heading level two", "mdHeading"]],
      [
        ["Inline ", "text"],
        ["`code`", "mdCode"],
        [" and ", "text"],
        ["[link](https://example.com)", "mdLink"],
        [" text", "text"],
      ],
      [
        ["<", "operator"],
        ["em", "markupTag"],
        [">", "operator"],
        ["emphasis", "text"],
        ["</", "operator"],
        ["em", "markupTag"],
        [">", "operator"],
      ],
      [
        ["- ", "operator"],
        ["list item ", "text"],
        ["`x`", "mdCode"],
      ],
    ],
  },
  RegExp: {
    code: [
      [["# Regular expressions", "lineComment"]],
      [
        ["^[a-z]", "regexp"],
        ["+", "operator"],
        ["(\\d{2,3})", "regexp"],
        ["?", "operator"],
        ["$", "regexp"],
      ],
      [
        ["(?P<year>", "regexp"],
        ["\\d{4}", "regexp"],
        [")", "regexp"],
        ["-", "operator"],
        ["(\\d{2})", "regexp"],
      ],
      [
        ["\\bword\\b", "regexp"],
        [" | ", "operator"],
        ["[[:alpha:]]", "regexp"],
      ],
    ],
  },
  Java: {
    code: [
      [["// Java", "java.lineComment"]],
      [["@Override", "java.metadata"]],
      [
        ["public class ", "java.keyword"],
        ["Greeter", "java.className"],
        [" {", "java.operator"],
      ],
      [
        ["    private static final ", "java.keyword"],
        ["int", "java.keyword"],
        [" MAX", "java.constant"],
        [" = ", "java.operator"],
        ["3", "java.number"],
        [";", "java.separator"],
      ],
      [
        ["    private ", "java.keyword"],
        ["String", "java.className"],
        [" name", "java.field"],
        [" = ", "java.operator"],
        ['"a', "java.string"],
        ["\\n", "java.escape"],
        ['"', "java.string"],
        [";", "java.separator"],
      ],
      [["    /** doc comment */", "java.docComment"]],
      [
        ["    public ", "java.keyword"],
        ["void", "java.keyword"],
        ["greet", "java.functionDeclaration"],
        ["(", "java.operator"],
        ["String", "java.className"],
        [" name", "java.parameter"],
        [")", "java.operator"],
        [" {", "java.operator"],
      ],
      [
        ["        ", "text"],
        ["System", "java.predefined"],
        [".", "java.operator"],
        ["out", "java.field"],
        [".", "java.operator"],
        ["println", "java.functionCall"],
        ["(", "java.operator"],
        ["name", "java.identifier"],
        [")", "java.operator"],
        [";", "java.separator"],
      ],
      [
        ["        ", "text"],
        ["Greeter", "java.className"],
        [".", "java.operator"],
        ["MAX", "java.staticSymbol"],
      ],
      [["    }", "java.operator"]],
      [["}", "java.operator"]],
    ],
  },
  Kotlin: {
    code: [
      [["// Kotlin", "kotlin.lineComment"]],
      [["@JvmStatic", "kotlin.metadata"]],
      [
        ["class ", "kotlin.keyword"],
        ["Greeter", "kotlin.className"],
        ["(", "kotlin.operator"],
        ["val", "kotlin.keyword"],
        [" name", "kotlin.parameter"],
        [": ", "text"],
        ["String", "kotlin.className"],
        [")", "kotlin.operator"],
        [" {", "kotlin.operator"],
      ],
      [
        ["    companion ", "kotlin.keyword"],
        ["object", "kotlin.keyword"],
        [" {", "kotlin.operator"],
        [" const ", "kotlin.keyword"],
        ["val", "kotlin.keyword"],
        [" MAX", "kotlin.constant"],
        [" = ", "kotlin.operator"],
        ["3", "kotlin.number"],
        [" }", "kotlin.operator"],
      ],
      [
        ["    fun ", "kotlin.keyword"],
        ["greet", "kotlin.functionDeclaration"],
        ["(", "kotlin.operator"],
        ["name", "kotlin.parameter"],
        [": ", "text"],
        ["String", "kotlin.className"],
        ["): ", "text"],
        ["String", "kotlin.className"],
        [" = ", "kotlin.operator"],
        ['"a', "kotlin.string"],
        ["\\n", "kotlin.escape"],
        ['"', "kotlin.string"],
      ],
      [
        ["    ", "text"],
        ["println", "kotlin.predefined"],
        ["(", "kotlin.operator"],
        ["name", "kotlin.identifier"],
        [")", "kotlin.operator"],
      ],
      [["}", "kotlin.operator"]],
    ],
  },
  PHP: {
    code: [
      [["<?php", "php.scriptTag"]],
      [
        ["#[", "php.metadata"],
        ["Attr", "php.metadata"],
        ["]", "php.metadata"],
      ],
      [
        ["class ", "php.keyword"],
        ["Greeter", "php.className"],
        [" {", "php.brackets"],
      ],
      [
        ["    private static ", "php.keyword"],
        ["int", "php.className"],
        [" $max", "php.staticField"],
        [" = ", "php.operator"],
        ["3", "php.number"],
        [";", "php.separator"],
      ],
      [
        ["    public function ", "php.keyword"],
        ["greet", "php.functionDeclaration"],
        ["(", "php.brackets"],
        ["string", "php.className"],
        [" $name", "php.parameter"],
        ["): ", "text"],
        ["string", "php.className"],
        [" {", "php.brackets"],
      ],
      [
        ["        ", "text"],
        ["return", "php.keyword"],
        [" ", "text"],
        ['"hi', "php.string"],
        ["\\n", "php.escape"],
        ['"', "php.string"],
        ["  ", "text"],
        ["$name", "php.identifier"],
        [";", "php.separator"],
      ],
      [["    }", "php.brackets"]],
      [["}", "php.brackets"]],
    ],
  },
};

function AttributeEditor({
  attr,
  inherited,
  value,
  onChange,
}: {
  attr: AttributeDef;
  inherited: TextAttributesOverride;
  value: TextAttributesOverride | undefined;
  onChange: (v: TextAttributesOverride | undefined) => void;
}) {
  const v = value ?? {};
  const set = (patch: Partial<TextAttributesOverride>) => {
    const next: TextAttributesOverride = { ...v, ...patch };
    for (const k of Object.keys(next) as Array<keyof TextAttributesOverride>)
      if (next[k] === undefined || next[k] === inherited[k]) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className={styles.attrEditor} aria-label={`${attr.name} attributes`}>
      {attr.italicOnly && (
        <div className={styles.attrRow}>
          <Checkbox
            checked={v.italic ?? inherited.italic ?? attr.defaultItalic ?? true}
            onChange={(b) => set({ italic: b === (inherited.italic ?? attr.defaultItalic ?? true) ? undefined : b })}
            label="Italic"
          />
        </div>
      )}
      {attr.token && !attr.italicOnly && (
        <>
          <div className={styles.attrRow}>
            <Checkbox
              checked={v.bold ?? inherited.bold ?? false}
              onChange={(b) => set({ bold: b === (inherited.bold ?? false) ? undefined : b })}
              label="Bold"
            />
            <Checkbox
              checked={v.italic ?? inherited.italic ?? false}
              onChange={(b) => set({ italic: b === (inherited.italic ?? false) ? undefined : b })}
              label="Italic"
            />
          </div>
        </>
      )}
      {attr.fg && (
        <ColorRow
          label="Foreground"
          value={v.foreground}
          inherited={inherited.foreground}
          onChange={(c) => set({ foreground: c })}
        />
      )}
      {(attr.bg || (attr.token && !attr.italicOnly)) && (
        <ColorRow
          label="Background"
          value={v.background}
          inherited={inherited.background}
          onChange={(c) => set({ background: c })}
        />
      )}
      {attr.effect && (
        <ColorRow
          label="Effects"
          value={v.effectColor}
          inherited={inherited.effectColor}
          onChange={(c) => set({ effectColor: c })}
        />
      )}
      {attr.token && !attr.italicOnly && (
        <>
          <div className={styles.attrRow}>
            <Checkbox
              checked={!!(v.effect ?? inherited.effect) && (v.effect ?? inherited.effect) !== "none"}
              onChange={(b) =>
                set({
                  effect: b
                    ? inherited.effect && inherited.effect !== "none"
                      ? inherited.effect
                      : "underline"
                    : inherited.effect && inherited.effect !== "none"
                      ? "none"
                      : undefined,
                  effectColor: b ? v.effectColor : undefined,
                })
              }
              label="Effects"
            />
            {!!(v.effect ?? inherited.effect) && (v.effect ?? inherited.effect) !== "none" && (
              <ColorInput
                value={v.effectColor ?? inherited.effectColor ?? "#808080"}
                onChange={(c) => set({ effectColor: c ?? "#808080" })}
                label="Effect color"
              />
            )}
          </div>
          {!!(v.effect ?? inherited.effect) && (v.effect ?? inherited.effect) !== "none" && (
            <Select
              value={(v.effect ?? inherited.effect)!}
              options={[
                { value: "underline", label: "Underscored" },
                { value: "wave", label: "Underwaved" },
                { value: "strikeout", label: "Strikeout" },
              ]}
              onChange={(e) => set({ effect: e as TextAttributesOverride["effect"] })}
              className={styles.effectSelect}
              aria-label="Effect"
            />
          )}
        </>
      )}
      {!attr.italicOnly && (
        <div className={styles.inherited}>
          <T>The controls show the scheme's actual appearance; changes override it.</T>
        </div>
      )}
    </div>
  );
}

function ColorInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (c: string | undefined) => void;
  label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <>
      <span className={styles.colorBox} style={{ background: value }}>
        <input
          type="color"
          aria-label={label}
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#808080"}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
      <Input
        mono
        className={styles.swatchInput}
        aria-label={tx`${label} hex`}
        value={draft ?? value}
        invalid={draft !== null && !HEX_COLOR.test(draft)}
        onChange={(e) => {
          setDraft(e.target.value);
          if (HEX_COLOR.test(e.target.value)) onChange(e.target.value.toLowerCase());
        }}
        onBlur={() => setDraft(null)}
      />
    </>
  );
}

function ColorRow({
  label,
  value,
  inherited,
  onChange,
}: {
  label: string;
  value: string | undefined;
  inherited: string | undefined;
  onChange: (c: string | undefined) => void;
}) {
  const cleared = value === CLEAR_COLOR;
  const shown = cleared ? undefined : (value ?? inherited);
  return (
    <div className={styles.attrRow}>
      <Checkbox
        checked={shown !== undefined}
        onChange={(on) =>
          onChange(
            on
              ? cleared
                ? (inherited ?? "#808080")
                : (shown ?? "#808080")
              : inherited !== undefined
                ? CLEAR_COLOR
                : undefined,
          )
        }
        label={label}
      />
      {shown !== undefined && <ColorInput value={shown} onChange={onChange} label={label} />}
    </div>
  );
}

function ColorSchemePage({ scopes, landing }: { scopes: readonly string[]; landing?: boolean }) {
  const [scheme, setScheme] = useSetting<string>("editor.colorScheme", "global");
  const [overrides, setOverrides] = useSetting<Overrides>("editor.colorOverrides", "global");
  const [weight] = useSetting<number>("editor.fontWeight");
  const [boldFontWeight] = useSetting<number>("editor.boldFontWeight");
  const [rawCustoms, setCustoms] = useSetting<CustomColorSchemes>("editor.customSchemes", "global");
  const customs = useMemo(() => customSchemes(rawCustoms), [rawCustoms]);
  const [report, setReport] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string>("keyword");
  // One scope per page: the scope's own name is the page, not a tree level.
  const roots = useMemo(() => pageTree(scopes)[0]?.children ?? [], [scopes]);
  const ids = useMemo(() => treeIds(roots), [roots]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedFor, setExpandedFor] = useState(scopes);
  if (expandedFor !== scopes) {
    // Scope pages share this component; restart expansion on page switch.
    setExpandedFor(scopes);
    setExpanded(new Set(roots.filter((n) => n.children?.length).map((n) => n.key)));
  }
  // Language pages have their own attributes; keep the editor on a row of this page.
  if (roots.length && !ids.has(selected)) setSelected(firstLeafId(roots));
  /** Preview click: select the attribute and expand its ancestors. */
  const reveal = (attrId: string) => {
    const a = ATTRIBUTES.find((x) => x.id === attrId);
    if (!a) return;
    setSelected(attrId);
    setExpanded((prev) => {
      const next = new Set(prev);
      let key = "";
      for (const seg of attrSegs(a)) {
        key += `/${seg}`;
        next.add(key);
      }
      return next;
    });
  };
  const id = effectiveScheme(scheme, undefined, customs);
  const mine = overrides?.[id];
  const attr = ATTRIBUTES.find((a) => a.id === selected);
  const language = attr?.language;
  const inherited = useMemo(() => (attr ? resolvedAttribute(id, attr.id, customs) : {}), [id, attr, customs]);
  const vars = useMemo(
    () => ({ ...previewVars(id, mine, customs, language), ...fontWeightVars(weight, boldFontWeight) }) as CSSProperties,
    [id, mine, customs, language, weight, boldFontWeight],
  );
  const baseVars = useMemo(
    () => ({ ...previewVars(id, mine, customs), ...fontWeightVars(weight, boldFontWeight) }) as CSSProperties,
    [id, mine, customs, weight, boldFontWeight],
  );
  const update = (attrId: string, v: TextAttributesOverride | undefined) => {
    const next: Overrides = { ...(overrides ?? {}) };
    const forScheme = { ...(next[id] ?? {}) };
    if (v) forScheme[attrId] = v;
    else delete forScheme[attrId];
    if (Object.keys(forScheme).length) next[id] = forScheme;
    else delete next[id];
    setOverrides(next);
  };
  const schemes = listSchemes(customs);
  const sample = SAMPLES[scopes[0] ?? ""] ?? SAMPLES["Language Defaults"]!;
  const schemeName = schemes.find((s) => s.id === id)?.name ?? id;
  const options: SelectOption[] = [
    { value: "theme-default", label: "Theme default" },
    ...schemes.map((s) => ({ value: s.id, label: s.name })),
  ];
  const handlers = useRef<Record<string, (path?: string) => Promise<void>>>({});
  useEffect(() => {
    handlers.current = {
      import: async (file) => {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const path =
          file ??
          (await open({
            multiple: false,
            filters: [{ name: tx("IntelliJ Color Scheme"), extensions: ["icls"] }],
          }));
        if (!path) return;
        const parsed = parseIcls(await call(commands.fsReadText(path)));
        let overwrite = false;
        if (schemes.some((s) => s.name === parsed.scheme.name)) {
          const canOverwrite = Object.values(customs).some((s) => s.name === parsed.scheme.name);
          const { button } = await ask({
            title: tx("Import Scheme"),
            body: tx`A scheme named '${parsed.scheme.name}' already exists.`,
            buttons: [
              ...(canOverwrite ? [{ id: "overwrite", label: tx("Overwrite") }] : []),
              { id: "both", label: tx("Keep Both"), primary: true },
            ],
          });
          if (button !== "overwrite" && button !== "both") return;
          overwrite = button === "overwrite";
        }
        const next = importScheme(customs, parsed.scheme, overwrite);
        setCustoms(next.customs);
        if (overwrite)
          setOverrides(Object.fromEntries(Object.entries(overrides ?? {}).filter(([key]) => key !== next.id)));
        setScheme(next.id);
        setReport(tx`Applied ${parsed.applied} values; skipped ${parsed.skipped} unsupported or invalid values.`);
      },
      export: async (file) => {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path =
          file ??
          (await save({
            defaultPath: `${schemeName.replace(/[/\\:*?"<>|]/g, "_")}.icls`,
            filters: [{ name: tx("IntelliJ Color Scheme"), extensions: ["icls"] }],
          }));
        if (!path) return;
        const bytes = Array.from(new TextEncoder().encode(exportIcls(id, customs, mine)));
        // The save dialog already confirmed replacing an existing file.
        await call(commands.fsDelete(path)).catch(() => {});
        await call(commands.fsCreateFileBytes(path, bytes));
        setReport(tx("Scheme exported."));
      },
      delete: async () => {
        if (
          !customs[id] ||
          !(await confirm({
            title: tx("Delete Scheme"),
            message: tx`Delete color scheme '${schemeName}'?`,
            ok: tx("Delete"),
          }))
        )
          return;
        const next = deleteScheme(customs, overrides ?? {}, scheme, id);
        setCustoms(next.customs);
        setOverrides(next.overrides);
        setScheme(next.selected);
        setReport("");
      },
    };
  });
  const pending = useRef(false);
  useEffect(
    () =>
      registerActions(
        (["import", "export", "delete"] as const).map((name) => ({
          id: `editor.colorScheme.${name}`,
          title: name === "import" ? "Import Scheme" : name === "export" ? "Export Scheme" : "Delete Scheme",
          category: "Editor",
          run: async ({ arg }) => {
            if (pending.current) return;
            pending.current = true;
            setBusy(true);
            try {
              await handlers.current[name]!(typeof arg === "string" ? arg : undefined);
            } catch (error) {
              await showError(
                tx("Color Scheme"),
                error instanceof Error && error.message === "Invalid .icls color scheme"
                  ? tx("Invalid .icls color scheme")
                  : String(error),
              );
            } finally {
              pending.current = false;
              setBusy(false);
            }
          },
        })),
      ),
    [],
  );
  return (
    <div className={styles.page}>
      <div className={styles.schemeRow}>
        <Row label="Scheme">
          <Select value={scheme} options={options} onChange={setScheme} aria-label="Scheme" />
        </Row>
        <Button size="small" disabled={busy} onClick={() => void executeAction("editor.colorScheme.import")}>
          <T>Import Scheme</T>
        </Button>
        <Button size="small" disabled={busy} onClick={() => void executeAction("editor.colorScheme.export")}>
          <T>Export Scheme</T>
        </Button>
        <Button
          size="small"
          disabled={busy || !customs[id]}
          onClick={() => void executeAction("editor.colorScheme.delete")}
        >
          <T>Delete Scheme</T>
        </Button>
        <Button
          size="small"
          disabled={!mine}
          onClick={() => setOverrides(Object.fromEntries(Object.entries(overrides ?? {}).filter(([k]) => k !== id)))}
        >
          <T>Restore Defaults</T>
        </Button>
      </div>
      {report && (
        <div role="status" className={styles.note}>
          {report}
        </div>
      )}
      {scheme === "theme-default" && (
        <div className={styles.note}>{tx`Follows the IDE theme: currently ${schemeName}.`}</div>
      )}
      {landing ? (
        <nav className={styles.schemeLinks} aria-label={tx("Color scheme pages")}>
          {SCHEME_SUBPAGES.map((p) => (
            <button key={p.id} type="button" className={styles.schemeLink} onClick={() => selectPage(p.id)}>
              {tx(p.title)}
            </button>
          ))}
        </nav>
      ) : (
        <>
          <div className={styles.schemeBody} style={baseVars}>
            <div className={styles.attrTree}>
              <Tree<Node>
                aria-label="Color scheme attributes"
                roots={roots}
                getKey={(n) => n.key}
                getLabel={(n) => n.label}
                getChildren={(n) => n.children}
                isExpandable={(n) => !!n.children?.length}
                expanded={expanded}
                onExpandedChange={setExpanded}
                multiSelect={false}
                selected={new Set([selected])}
                onSelectionChange={(_s, lead) => lead?.attr && setSelected(lead.attr.id)}
                renderNode={(n) => (
                  <span className={`${styles.treeLabel} ${n.attr && mine?.[n.attr.id] ? styles.attrModified : ""}`}>
                    {n.label}
                  </span>
                )}
                speedSearch
              />
            </div>
            {attr ? (
              <div className={styles.attrPanel}>
                <AttributeEditor
                  key={`${id}/${attr.id}`}
                  attr={attr}
                  inherited={inherited}
                  value={mine?.[attr.id]}
                  onChange={(v) => update(attr.id, v)}
                />
              </div>
            ) : (
              <div />
            )}
          </div>
          <pre className={styles.schemePreview} style={vars} aria-label={tx("Color scheme preview")}>
            {sample.code.map((line, i) => (
              <div key={i} className={`${styles.previewLine} ${i === sample.caret ? styles.previewCaretLine : ""}`}>
                <span className={styles.previewGutter}>{i + 1}</span>
                <code>
                  {line.map(([text, attrId], j) => {
                    const inPage = attrId !== undefined && ids.has(attrId);
                    return (
                      <span
                        key={j}
                        style={tokenStyle(attrId ? A(attrId) : undefined)}
                        className={inPage ? styles.clickable : undefined}
                        onClick={inPage && attrId ? () => reveal(attrId) : undefined}
                      >
                        {text}
                      </span>
                    );
                  })}
                </code>
              </div>
            ))}
          </pre>
        </>
      )}
    </div>
  );
}

const LANGUAGES = [...new Set(ATTRIBUTES.map((a) => a.path[0]!))].filter(
  (s) => !["General", "Debugger", "Language Defaults"].includes(s),
);

/** Sub-pages linked from the Color Scheme landing page, in sidebar order. */
const SCHEME_SUBPAGES = [
  { id: "editor.colorScheme.general", title: "General" },
  { id: "editor.colorScheme.language-defaults", title: "Language Defaults" },
  { id: "editor.colorScheme.debugger", title: "Debugger" },
  ...LANGUAGES.map((l) => ({ id: `editor.colorScheme.${l.toLowerCase()}`, title: l })),
];

/** The scope chooser, import/export buttons and preview are identical on every sub-page. */
function colorSchemeSection(scopes: readonly string[]) {
  return {
    items: [
      {
        t: "custom" as const,
        label: "Scheme",
        keywords: ATTRIBUTES.filter((a) => scopes.includes(a.path[0]!)).map((a) => a.name),
        component: () => <ColorSchemePage scopes={scopes} />,
      },
    ],
  };
}

export const COLOR_SCHEME_PAGE = editorPage({
  id: "editor.colorScheme",
  title: "Color Scheme",
  order: 23,
  projectScope: false,
  keywords: [
    "colors",
    "syntax highlighting",
    "theme",
    "foreground",
    "background",
    "bold",
    "italic",
    ...SCHEMES.map((s) => s.name),
  ],
  sections: [
    {
      items: [
        {
          t: "custom" as const,
          label: "Scheme",
          keywords: SCHEMES.map((s) => s.name),
          component: () => <ColorSchemePage scopes={[]} landing />,
        },
      ],
    },
  ],
});

/** JetBrains layout: scopes and languages live in the settings tree under Color Scheme, one page each. */
export const COLOR_SCHEME_PAGES: PageSpec[] = [
  COLOR_SCHEME_PAGE,
  editorPage({
    id: "editor.colorScheme.general",
    title: "General",
    order: 1,
    projectScope: false,
    keywords: ATTRIBUTES.filter((a) => a.path[0] === "General").map((a) => a.name),
    sections: [colorSchemeSection(["General"])],
  }),
  editorPage({
    id: "editor.colorScheme.language-defaults",
    title: "Language Defaults",
    order: 2,
    projectScope: false,
    keywords: ["semantic highlighting", "rainbow"],
    sections: [
      colorSchemeSection(["Language Defaults"]),
      {
        title: "Language Defaults",
        items: [
          {
            t: "check",
            key: "editor.semanticHighlighting",
            label: "Semantic highlighting",
            hint: "Local variables and parameters get a colour derived from their name (needs a language server).",
          },
          {
            t: "check",
            key: "editor.rainbowBrackets",
            label: "Rainbow brackets",
            hint: "Color (), [] and {} by nesting depth; unmatched brackets use the error color.",
          },
        ],
      },
    ],
  }),
  editorPage({
    id: "editor.colorScheme.debugger",
    title: "Debugger",
    order: 3,
    projectScope: false,
    keywords: ["breakpoint", "inline values"],
    sections: [colorSchemeSection(["Debugger"])],
  }),
  ...LANGUAGES.map((language, i) =>
    editorPage({
      id: `editor.colorScheme.${language.toLowerCase()}`,
      title: language,
      order: 4 + i,
      projectScope: false,
      keywords: ATTRIBUTES.filter((a) => a.path[0] === language).map((a) => a.name),
      sections: [colorSchemeSection([language])],
    }),
  ),
];
