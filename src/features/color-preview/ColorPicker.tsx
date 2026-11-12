import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditorView } from "@codemirror/view";
import { RgbaColorPicker } from "react-colorful";
import { useTx } from "@/platform/i18n";
import { IconButton, Popup } from "@/ui";
import { fromHex, toHex8, type Rgba } from "./colors";
import styles from "./ColorPicker.module.css";

interface PickerRequest {
  view: EditorView;
  anchor: { x: number; y: number };
  value: Rgba;
  onChange?: (value: Rgba) => void;
  onCommit?: (value: Rgba) => void;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let active: (PickerRequest & { initial: Rgba }) | null = null;
let sequence = 0;
const RECENT_KEY = "openidea.colorPicker.recent.v1";
const MAX_RECENT = 20;

function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && fromHex(item) !== null).slice(0, MAX_RECENT)
      : [];
  } catch {
    return [];
  }
}

function rememberColor(value: Rgba) {
  const hex = toHex8(value);
  const recent = [hex, ...readRecent().filter((item) => item.toLowerCase() !== hex)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Storage can be unavailable in a restricted WebView.
  }
}

interface EyeDropperResult {
  sRGBHex: string;
}

interface EyeDropperInstance {
  open(): Promise<EyeDropperResult>;
}

type EyeDropperWindow = Window & { EyeDropper?: new () => EyeDropperInstance };

function render() {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  root.render(active ? <Picker key={sequence} id={sequence} request={active} /> : null);
}

export function openColorPicker(request: PickerRequest) {
  closeColorPicker();
  active = { ...request, initial: [...request.value] };
  sequence++;
  render();
}

export function closeColorPicker() {
  const previous = active;
  active = null;
  if (root) render();
  if (previous?.value.some((channel, index) => channel !== previous.initial[index])) rememberColor(previous.value);
  previous?.onCommit?.(previous.value);
}

export function closeColorPickerFor(view: EditorView) {
  if (active?.view !== view) return;
  active = null;
  if (root) render();
}

export function disposeColorPicker() {
  active = null;
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}

function Field({
  label,
  name,
  value,
  maxLength,
  inputMode,
  isValid,
  onValid,
}: {
  label: string;
  name: string;
  value: string;
  maxLength: number;
  inputMode: "numeric" | "text";
  isValid: (text: string) => boolean;
  onValid: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const t = useTx();
  const shown = draft ?? value;
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        aria-label={t(name)}
        aria-invalid={shown !== "" && !isValid(shown)}
        inputMode={inputMode}
        maxLength={maxLength}
        spellCheck={false}
        value={shown}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          if (isValid(next)) onValid(next);
        }}
        onBlur={() => setDraft(null)}
        onFocus={(event) => event.currentTarget.select()}
      />
    </label>
  );
}

function Picker({ id, request }: { id: number; request: PickerRequest }) {
  const [value, setValue] = useState<Rgba>(request.value);
  const [recent] = useState(readRecent);
  const [sampling, setSampling] = useState(false);
  const t = useTx();
  const eyeDropper = (window as EyeDropperWindow).EyeDropper;
  useEffect(() => {
    const close = () => closeColorPickerFor(request.view);
    request.view.scrollDOM.addEventListener("scroll", close);
    return () => request.view.scrollDOM.removeEventListener("scroll", close);
  }, [request.view]);

  const update = (next: Rgba) => {
    setValue(next);
    if (sequence === id && active) active = { ...active, value: next };
    request.onChange?.(next);
  };
  const channel = (index: 0 | 1 | 2, text: string) => {
    const number = Number(text);
    const next: Rgba = [...value];
    next[index] = number;
    update(next);
  };
  const alpha = (text: string) => {
    const number = Number(text);
    update([value[0], value[1], value[2], number / 100]);
  };
  const hex = (text: string) => {
    const next = fromHex(text);
    if (next) update(next);
  };
  const numeric = (max: number) => (text: string) => /^\d{1,3}$/.test(text) && Number(text) <= max;
  const sampleScreen = async () => {
    if (!eyeDropper || sampling) return;
    setSampling(true);
    try {
      const result = await new eyeDropper().open();
      const next = fromHex(result.sRGBHex);
      if (next && sequence === id && active) update(next);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.warn(error);
    } finally {
      if (sequence === id && active) setSampling(false);
    }
  };

  return (
    <Popup
      open
      anchor={request.anchor}
      placement="bottom-start"
      offset={4}
      onClose={closeColorPicker}
      aria-label={t("Color picker")}
      className={styles.popup}
      trapFocus
      closeOnDeactivate={false}
    >
      <div className={styles.pickerArea}>
        <RgbaColorPicker
          className={styles.control}
          color={{ r: value[0], g: value[1], b: value[2], a: value[3] }}
          onChange={({ r, g, b, a }) => update([r, g, b, a])}
        />
        <div className={styles.sampleRow}>
          <IconButton
            icon="eyedropper"
            title="Pick screen color"
            size="small"
            disabled={!eyeDropper || sampling}
            onClick={() => void sampleScreen()}
          />
          <div className={styles.preview} role="img" aria-label={t("Current color")}>
            <span style={{ backgroundColor: `rgba(${value.join(", ")})` }} />
          </div>
        </div>
      </div>
      <div className={styles.fields}>
        <Field
          label="R"
          name="Red"
          value={String(value[0])}
          maxLength={3}
          inputMode="numeric"
          isValid={numeric(255)}
          onValid={(v) => channel(0, v)}
        />
        <Field
          label="G"
          name="Green"
          value={String(value[1])}
          maxLength={3}
          inputMode="numeric"
          isValid={numeric(255)}
          onValid={(v) => channel(1, v)}
        />
        <Field
          label="B"
          name="Blue"
          value={String(value[2])}
          maxLength={3}
          inputMode="numeric"
          isValid={numeric(255)}
          onValid={(v) => channel(2, v)}
        />
        <Field
          label="A%"
          name="Alpha percent"
          value={String(Math.round(value[3] * 100))}
          maxLength={3}
          inputMode="numeric"
          isValid={numeric(100)}
          onValid={alpha}
        />
        <Field
          label={t("HEX")}
          name="Hexadecimal"
          value={toHex8(value).slice(1).toUpperCase()}
          maxLength={9}
          inputMode="text"
          isValid={(v) => fromHex(v) !== null}
          onValid={hex}
        />
      </div>
      {recent.length > 0 && (
        <div className={styles.recent} role="group" aria-label={t("Recent colors")}>
          {recent.map((hex) => (
            <button
              key={hex}
              type="button"
              title={hex.toUpperCase()}
              aria-label={`${t("Recent color")} ${hex.toUpperCase()}`}
              aria-pressed={hex.toLowerCase() === toHex8(value)}
              className={styles.recentColor}
              onClick={() => {
                const next = fromHex(hex);
                if (next) update(next);
              }}
            >
              <span style={{ backgroundColor: hex }} />
            </button>
          ))}
        </div>
      )}
    </Popup>
  );
}
