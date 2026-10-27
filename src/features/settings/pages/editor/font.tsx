/**
 * Editor › Font: family (installed fonts, monospaced filter), size, line height,
 * ligatures, Typography Settings (main / bold weight, fallback font), editable preview.
 */
import { useMemo, useState } from "react";
import { Checkbox, type SelectOption, T } from "@/ui";
import { monoFontFamily } from "@/platform/fonts";
import { NumberInput, Row, SearchLabel, Select } from "../../components/Form";
import { useLabelMatch, useSetting } from "../../components/context";
import { FONT_WEIGHTS, fontWeightOf, fontWeightVars } from "@/platform/editorSettings";
import { LIMITS } from "../../model/schema";
import { editorPage } from "./kit";
import styles from "./Editor.module.css";

const CANDIDATES = [
  "JetBrains Mono",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Fira Code",
  "Fira Mono",
  "Source Code Pro",
  "Cascadia Code",
  "Cascadia Mono",
  "IBM Plex Mono",
  "Hack",
  "Inconsolata",
  "Roboto Mono",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Consolas",
  "Courier New",
  "PT Mono",
  "Andale Mono",
  "Victor Mono",
  "Iosevka",
  "Sarasa Mono SC",
  "Noto Sans Mono",
  "Noto Sans Mono CJK SC",
  "PingFang SC",
  "Hiragino Sans GB",
  "Microsoft YaHei",
  "Helvetica Neue",
  "Arial",
  "Inter",
  "Georgia",
];

interface FontInfo {
  name: string;
  mono: boolean;
}

let detected: FontInfo[] | null = null;

/** Installed candidates, detected by comparing glyph widths against generic fallbacks. */
export function installedFonts(): FontInfo[] {
  if (detected) return detected;
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  const ctx = canvas?.getContext?.("2d");
  if (!ctx) return (detected = CANDIDATES.map((name) => ({ name, mono: true })));
  const width = (font: string, text: string) => {
    ctx.font = `32px ${font}`;
    return ctx.measureText(text).width;
  };
  const sample = "mmmmmmmmmmlli1WQ@";
  const out: FontInfo[] = [];
  for (const name of CANDIDATES) {
    const quoted = `"${name}"`;
    const present = ["monospace", "serif", "sans-serif"].some(
      (base) => width(`${quoted}, ${base}`, sample) !== width(base, sample),
    );
    if (!present && name !== "JetBrains Mono") continue;
    out.push({
      name,
      mono: Math.abs(width(`${quoted}, monospace`, "iiiiiiiiii") - width(`${quoted}, monospace`, "WWWWWWWWWW")) < 0.5,
    });
  }
  return (detected = out);
}

function FontRow() {
  const [family, setFamily] = useSetting<string>("editor.fontFamily");
  const [monoOnly, setMonoOnly] = useState(true);
  const matched = useLabelMatch("Show only monospaced fonts");
  const options = useMemo<SelectOption[]>(() => {
    const list = installedFonts().filter((f) => !monoOnly || f.mono);
    const names = list.map((f) => f.name);
    if (!names.includes(family)) names.unshift(family);
    return names.map((n) => ({ value: n, label: n }));
  }, [family, monoOnly]);
  return (
    <Row label="Font">
      <span className={styles.fontFamily}>
        <span className={styles.fontSelect}>
          <Select value={family} options={options} onChange={setFamily} aria-label="Font" />
        </span>
        <span className={matched ? styles.matched : undefined}>
          <Checkbox
            checked={monoOnly}
            onChange={setMonoOnly}
            label={<SearchLabel text="Show only monospaced fonts" />}
          />
        </span>
      </span>
    </Row>
  );
}

function SizeRow() {
  const [size, setSize] = useSetting<number>("editor.fontSize");
  const [line, setLine] = useSetting<number>("editor.lineHeight");
  return (
    <>
      <Row label="Size">
        <NumberInput value={size} onChange={setSize} {...LIMITS.fontSize} aria-label="Size" unit="px" />
      </Row>
      <Row label="Line height">
        <NumberInput value={line} onChange={setLine} {...LIMITS.lineHeight} aria-label="Line height" unit="px" />
      </Row>
    </>
  );
}

function FallbackRow() {
  const [fallback, setFallback] = useSetting<string>("editor.fallbackFont");
  const options = useMemo<SelectOption[]>(
    () => [{ value: "", label: "None" }, ...installedFonts().map((f) => ({ value: f.name, label: f.name }))],
    [],
  );
  return (
    <Row label="Fallback font" hint="For symbols not supported by the main font">
      <Select value={fallback} options={options} onChange={setFallback} aria-label="Fallback font" />
    </Row>
  );
}

const WEIGHT_OPTIONS: SelectOption[] = FONT_WEIGHTS.map(([w, name]) => ({ value: String(w), label: name, detail: String(w) }));

/**
 * IDEA's Main / Bold font weight. IDEA lists the weights the family ships; the
 * bundled JetBrains Mono is variable (100–900), and other families get the
 * standard names (the WebView picks the nearest face or synthesises bold).
 */
function WeightRows() {
  const [main, setMain] = useSetting<number>("editor.fontWeight");
  const [bold, setBold] = useSetting<number>("editor.boldFontWeight");
  return (
    <>
      <Row label="Main font weight">
        <Select
          value={String(fontWeightOf(main, 400))}
          options={WEIGHT_OPTIONS}
          onChange={(v) => setMain(Number(v))}
          aria-label="Main font weight"
        />
      </Row>
      <Row label="Bold font weight" hint="Used wherever the color scheme shows text in bold">
        <Select
          value={String(fontWeightOf(bold, 700))}
          options={WEIGHT_OPTIONS}
          onChange={(v) => setBold(Number(v))}
          aria-label="Bold font weight"
        />
      </Row>
    </>
  );
}

const SAMPLE = `OpenIDEA is a full-featured IDE
with a high level of usability and outstanding
advanced code editing and refactoring support.

abcdefghijklmnopqrstuvwxyz 0123456789 (){}[]
ABCDEFGHIJKLMNOPQRSTUVWXYZ +-*/= .,;:!? #&$%@|^

<!-- -- != := === >= >- >=> |-> -> <$> </> #[ |||> |= ~@

中文字体回退示例 · 日本語 · 한국어
`;

function Preview() {
  const [family] = useSetting<string>("editor.fontFamily");
  const [fallback] = useSetting<string>("editor.fallbackFont");
  const [size] = useSetting<number>("editor.fontSize");
  const [line] = useSetting<number>("editor.lineHeight");
  const [ligatures] = useSetting<boolean>("editor.ligatures");
  const [weight] = useSetting<number>("editor.fontWeight");
  const [boldWeight] = useSetting<number>("editor.boldFontWeight");
  const [text, setText] = useState(SAMPLE);
  const fam = monoFontFamily(family, fallback, "var(--font-mono)");
  return (
    <>
      <div className={styles.previewTitle}>
        <T>Preview</T>
      </div>
      <textarea
        className={styles.previewArea}
        aria-label="Font preview"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{
          ...fontWeightVars(weight, boldWeight),
          fontFamily: fam,
          fontSize: `${size}px`,
          lineHeight: `${line}px`,
          fontVariantLigatures: ligatures ? "normal" : "none",
        }}
      />
    </>
  );
}

export const FONT_PAGE = editorPage({
  id: "editor.font",
  title: "Font",
  order: 22,
  projectScope: true,
  keywords: ["typeface", "monospace", "ligatures", "font size", "line spacing", "font weight", "bold"],
  sections: [
    {
      items: [
        { t: "custom", label: "Font", keywords: ["font family", "Show only monospaced fonts"], component: FontRow },
        { t: "custom", label: "Size", keywords: ["Line height"], component: SizeRow },
        { t: "check", key: "editor.ligatures", label: "Enable ligatures" },
      ],
    },
    {
      title: "Typography Settings",
      items: [
        { t: "custom", label: "Main font weight", keywords: ["Bold font weight"], component: WeightRows },
        { t: "custom", label: "Fallback font", component: FallbackRow },
      ],
    },
  ],
  footer: Preview,
});
