/**
 * Editor › Color Scheme: scheme chooser, the IDEA attribute tree (General,
 * Language Defaults, languages) with a foreground / background / bold /
 * italic / effects editor, and a live preview. Edits are staged in
 * `editor.colorOverrides[scheme][attribute]`; `editor/core` injects them.
 */
import { useMemo, useState, type CSSProperties } from "react";
import { Button, Checkbox, Input, Tree, type SelectOption, T } from "@/ui";
import { fontWeightVars, type TextAttributesOverride } from "@/platform/editorSettings";
import {
  ATTRIBUTES,
  SCHEMES,
  boldWeight,
  effectiveScheme,
  schemeTokens,
  type AttributeDef,
  type SchemeId,
} from "@/platform/colorScheme";
import { HEX_COLOR } from "../../model/schema";
import { Row, Select } from "../../components/Form";
import { useSetting } from "../../components/context";
import { editorPage } from "./kit";
import styles from "./Editor.module.css";

type Overrides = Record<string, Record<string, TextAttributesOverride>>;

const SCHEME_OPTIONS: SelectOption[] = [
  { value: "theme-default", label: "Theme default" },
  ...SCHEMES.map((s) => ({ value: s.id, label: s.name })),
];

interface Node {
  key: string;
  label: string;
  attr?: AttributeDef;
  children?: Node[];
}

function buildTree(): Node[] {
  const roots: Node[] = [];
  for (const attr of ATTRIBUTES) {
    let level = roots;
    let key = "";
    for (const seg of attr.path) {
      key += `/${seg}`;
      let n = level.find((x) => x.key === key);
      if (!n) level.push((n = { key, label: seg, children: [] }));
      level = n.children!;
    }
    level.push({ key: attr.id, label: attr.name, attr });
  }
  return roots;
}

const TREE = buildTree();

/** CSS custom properties of a scheme plus pending overrides (for the preview). */
function previewVars(id: SchemeId, o: Record<string, TextAttributesOverride> | undefined): CSSProperties {
  const vars: Record<string, string> = {};
  for (const [k, v] of schemeTokens(id))
    if (
      k.startsWith("--syn-") ||
      k.startsWith("--fg-") ||
      k.startsWith("--bg-") ||
      k.startsWith("--border-") ||
      k === "--caret"
    )
      vars[k] = v;
  vars["--bg-editor"] = schemeTokens(id).get("--bg-editor") ?? schemeTokens(id).get("--bg-island") ?? "";
  for (const attr of ATTRIBUTES) {
    const ov = o?.[attr.id];
    if (!ov) continue;
    if (ov.foreground && attr.fg) vars[attr.fg] = ov.foreground;
    if (ov.background && attr.bg) vars[attr.bg] = ov.background;
    if (attr.token) {
      if (ov.bold !== undefined) vars[`--syn-${attr.token}-bold`] = boldWeight(ov.bold);
      if (ov.italic !== undefined) vars[`--syn-${attr.token}-italic`] = ov.italic ? "italic" : "normal";
      if (ov.background) vars[`--syn-${attr.token}-bg`] = ov.background;
      if (ov.effect && ov.effect !== "none")
        vars[`--syn-${attr.token}-effect`] =
          `${ov.effect === "strikeout" ? "line-through" : ov.effect === "wave" ? "underline wavy" : "underline"} ${ov.effectColor ?? "currentColor"}`;
    }
  }
  return vars as CSSProperties;
}

/** Text styled like an attribute in the preview. */
function tokenStyle(attr: AttributeDef | undefined): CSSProperties {
  if (!attr?.token) return attr?.fg ? { color: `var(${attr.fg})` } : {};
  const t = attr.token;
  return {
    color: `var(--syn-${t})`,
    fontWeight: `var(--syn-${t}-bold, inherit)` as CSSProperties["fontWeight"],
    fontStyle: `var(--syn-${t}-italic, ${t === "comment" ? "var(--syn-comment-style)" : t === "doc-comment" || t === "docstring" ? "italic" : "inherit"})`,
    backgroundColor: `var(--syn-${t}-bg, transparent)`,
    textDecoration: `var(--syn-${t}-effect, none)`,
  };
}

const A = (id: string) => ATTRIBUTES.find((a) => a.id === id);

type Seg = [string, string?];
const SAMPLE: Seg[][] = [
  [["# OpenIDEA color scheme preview", "lineComment"]],
  [["import ", "keyword"], ["os"]],
  [["@dataclass", "pyDecorator"]],
  [["class ", "keyword"], ["Greeter", "className"], [":"]],
  [['    """Says hello."""', "pyDocstring"]],
  [
    ["    MAX_RETRIES", "constant"],
    [" = ", "operator"],
    ["3", "number"],
  ],
  [
    ["    def ", "keyword"],
    ["greet", "functionDeclaration"],
    ["("],
    ["self", "pySelf"],
    [", "],
    ["name", "parameter"],
    ["):"],
  ],
  [
    ["        text", "identifier"],
    [" = ", "operator"],
    ['"Hello, ', "string"],
    ["\\n", "escape"],
    ['"', "string"],
    [" + name"],
  ],
  [["        "], ["print", "pyBuiltin"], ["(text, "], ["end", "pyKeywordArg"], ["="], ['""', "string"], [")"]],
  [["        return ", "keyword"], ["len", "functionCall"], ["(text)"]],
  [["# TODO: localize", "todo"]],
];

function AttributeEditor({
  attr,
  value,
  onChange,
}: {
  attr: AttributeDef;
  value: TextAttributesOverride | undefined;
  onChange: (v: TextAttributesOverride | undefined) => void;
}) {
  const v = value ?? {};
  const set = (patch: Partial<TextAttributesOverride>) => {
    const next: TextAttributesOverride = { ...v, ...patch };
    for (const k of Object.keys(next) as Array<keyof TextAttributesOverride>) if (next[k] === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className={styles.attrEditor} aria-label={`${attr.name} attributes`}>
      {attr.token && (
        <>
          <div className={styles.attrRow}>
            <Checkbox checked={!!v.bold} onChange={(b) => set({ bold: b || undefined })} label="Bold" />
            <Checkbox checked={!!v.italic} onChange={(b) => set({ italic: b || undefined })} label="Italic" />
          </div>
        </>
      )}
      {attr.fg && <ColorRow label="Foreground" value={v.foreground} onChange={(c) => set({ foreground: c })} />}
      {(attr.bg || attr.token) && (
        <ColorRow label="Background" value={v.background} onChange={(c) => set({ background: c })} />
      )}
      {attr.effect && <ColorRow label="Effects" value={v.effectColor} onChange={(c) => set({ effectColor: c })} />}
      {attr.token && (
        <div className={styles.attrRow}>
          <Checkbox
            checked={!!v.effect && v.effect !== "none"}
            onChange={(b) =>
              set({ effect: b ? "underline" : undefined, effectColor: b ? (v.effectColor ?? "#808080") : undefined })
            }
            label="Effects"
          />
          {v.effect && v.effect !== "none" && (
            <>
              <Select
                value={v.effect}
                options={[
                  { value: "underline", label: "Underscored" },
                  { value: "wave", label: "Underwaved" },
                  { value: "strikeout", label: "Strikeout" },
                ]}
                onChange={(e) => set({ effect: e as TextAttributesOverride["effect"] })}
                aria-label="Effect"
              />
              <ColorInput
                value={v.effectColor ?? "#808080"}
                onChange={(c) => set({ effectColor: c ?? "#808080" })}
                label="Effect color"
              />
            </>
          )}
        </div>
      )}
      <div className={styles.inherited}>
        <T>Unchecked values are inherited from the scheme.</T>
      </div>
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
        aria-label={`${label} hex`}
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
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (c: string | undefined) => void;
}) {
  return (
    <div className={styles.attrRow}>
      <Checkbox checked={value !== undefined} onChange={(on) => onChange(on ? "#808080" : undefined)} label={label} />
      {value !== undefined && <ColorInput value={value} onChange={onChange} label={label} />}
    </div>
  );
}

function ColorSchemePage() {
  const [scheme, setScheme] = useSetting<string>("editor.colorScheme");
  const [overrides, setOverrides] = useSetting<Overrides>("editor.colorOverrides");
  const [weight] = useSetting<number>("editor.fontWeight");
  const [boldFontWeight] = useSetting<number>("editor.boldFontWeight");
  const [selected, setSelected] = useState<string>("keyword");
  const id = effectiveScheme(scheme);
  const mine = overrides?.[id];
  const attr = ATTRIBUTES.find((a) => a.id === selected);
  const vars = useMemo(
    () => ({ ...previewVars(id, mine), ...fontWeightVars(weight, boldFontWeight) }) as CSSProperties,
    [id, mine, weight, boldFontWeight],
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
  const schemeName = SCHEMES.find((s) => s.id === id)?.name ?? id;
  return (
    <div className={styles.page}>
      <div className={styles.schemeRow}>
        <Row label="Scheme">
          <Select value={scheme} options={SCHEME_OPTIONS} onChange={setScheme} aria-label="Scheme" />
        </Row>
        <Button
          size="small"
          disabled={!mine}
          onClick={() => setOverrides(Object.fromEntries(Object.entries(overrides ?? {}).filter(([k]) => k !== id)))}
        >
          <T>Restore Defaults</T>
        </Button>
      </div>
      {scheme === "theme-default" && <div className={styles.note}>Follows the IDE theme: currently {schemeName}.</div>}
      <div className={styles.schemeBody}>
        <div className={styles.attrTree}>
          <Tree<Node>
            aria-label="Color scheme attributes"
            roots={TREE}
            getKey={(n) => n.key}
            getLabel={(n) => n.label}
            getChildren={(n) => n.children}
            isExpandable={(n) => !!n.children}
            defaultExpanded={["/Language Defaults", "/General", "/General/Code"]}
            multiSelect={false}
            selected={new Set([selected])}
            onSelectionChange={(_s, lead) => lead?.attr && setSelected(lead.attr.id)}
            getColor={(n) => (n.attr && mine?.[n.attr.id] ? "var(--accent)" : undefined)}
            speedSearch
          />
        </div>
        {attr ? (
          <AttributeEditor
            key={`${id}/${attr.id}`}
            attr={attr}
            value={mine?.[attr.id]}
            onChange={(v) => update(attr.id, v)}
          />
        ) : (
          <div />
        )}
      </div>
      <pre className={styles.schemePreview} style={vars} aria-label="Color scheme preview">
        {SAMPLE.map((line, i) => (
          <div key={i} className={`${styles.previewLine} ${i === 6 ? styles.previewCaretLine : ""}`}>
            <span className={styles.previewGutter}>{i + 1}</span>
            <code>
              {line.map(([text, attrId], j) => (
                <span
                  key={j}
                  style={tokenStyle(attrId ? A(attrId) : undefined)}
                  className={attrId ? styles.clickable : undefined}
                  onClick={attrId ? () => setSelected(attrId) : undefined}
                >
                  {text}
                </span>
              ))}
            </code>
          </div>
        ))}
      </pre>
    </div>
  );
}

export const COLOR_SCHEME_PAGE = editorPage({
  id: "editor.colorScheme",
  title: "Color Scheme",
  order: 23,
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
    { items: [{ t: "custom", label: "Scheme", keywords: ATTRIBUTES.map((a) => a.name), component: ColorSchemePage }] },
  ],
});
