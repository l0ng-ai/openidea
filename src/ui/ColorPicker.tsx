import { useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { RgbColorPicker, RgbaColorPicker } from "react-colorful";
import { useTx } from "@/platform/i18n";
import { Button, IconButton } from "./Button";
import { Popup, type PopupAnchor } from "./Popup";
import { T } from "./T";
import { fromHex, fromOpaqueHex, toHex6, toHex8, type Rgba } from "./colorPickerValues";
import styles from "./ColorPicker.module.css";

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

export function rememberColor(value: Rgba) {
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
        onBlur={() => {
          if (!shown || isValid(shown)) setDraft(null);
        }}
        onFocus={(event) => event.currentTarget.select()}
      />
    </label>
  );
}

export function ColorPicker({
  anchor,
  initial,
  opaque = false,
  onChange,
  onFinish,
}: {
  anchor: PopupAnchor;
  initial: Rgba;
  opaque?: boolean;
  onChange?: (value: Rgba) => void;
  onFinish: (commit: boolean, value: Rgba) => void;
}) {
  const [value, setValue] = useState<Rgba>(initial);
  const [recent] = useState(readRecent);
  const [sampling, setSampling] = useState(false);
  const mounted = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const t = useTx();
  const eyeDropper = (window as EyeDropperWindow).EyeDropper;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = (next: Rgba) => {
    if (opaque) next = [next[0], next[1], next[2], 1];
    setValue(next);
    onChange?.(next);
  };
  const parseHex = opaque ? fromOpaqueHex : fromHex;
  const finish = (commit: boolean) => onFinish(commit, value);
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
    const next = parseHex(text);
    if (next) update(next);
  };
  const numeric = (max: number) => (text: string) => /^\d{1,3}$/.test(text) && Number(text) <= max;
  const sampleScreen = async () => {
    if (!eyeDropper || sampling) return;
    setSampling(true);
    try {
      const result = await new eyeDropper().open();
      const next = fromHex(result.sRGBHex);
      if (next && mounted.current) update(next);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.warn(error);
    } finally {
      if (mounted.current) setSampling(false);
    }
  };

  return (
    <Popup
      open
      anchor={anchor}
      placement="bottom-start"
      offset={4}
      onClose={(reason) => finish(reason !== "escape" && !form.current?.querySelector('[aria-invalid="true"]'))}
      aria-label={t("Color picker")}
      className={clsx(styles.popup, opaque && styles.opaque)}
      trapFocus
      closeOnDeactivate={false}
    >
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          if (!event.currentTarget.querySelector('[aria-invalid="true"]')) finish(true);
        }}
      >
        <div className={styles.pickerArea}>
          {opaque ? (
            <RgbColorPicker
              className={styles.control}
              color={{ r: value[0], g: value[1], b: value[2] }}
              onChange={({ r, g, b }) => update([r, g, b, 1])}
            />
          ) : (
            <RgbaColorPicker
              className={styles.control}
              color={{ r: value[0], g: value[1], b: value[2], a: value[3] }}
              onChange={({ r, g, b, a }) => update([r, g, b, a])}
            />
          )}
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
          {!opaque && (
            <Field
              label="A%"
              name="Alpha percent"
              value={String(Math.round(value[3] * 100))}
              maxLength={3}
              inputMode="numeric"
              isValid={numeric(100)}
              onValid={alpha}
            />
          )}
          <Field
            label={t("HEX")}
            name="Hexadecimal"
            value={(opaque ? toHex6(value) : toHex8(value)).slice(1).toUpperCase()}
            maxLength={opaque ? 7 : 9}
            inputMode="text"
            isValid={(v) => parseHex(v) !== null}
            onValid={hex}
          />
        </div>
        {recent.length > 0 && (
          <div className={styles.recent} role="group" aria-label={t("Recent colors")}>
            {recent.map((hex) => {
              const next = fromHex(hex)!;
              const display = opaque ? toHex6(next) : hex.toLowerCase();
              return (
                <button
                  key={hex}
                  type="button"
                  title={display.toUpperCase()}
                  aria-label={`${t("Recent color")} ${display.toUpperCase()}`}
                  aria-pressed={display === (opaque ? toHex6(value) : toHex8(value))}
                  className={styles.recentColor}
                  onClick={() => update(next)}
                >
                  <span style={{ backgroundColor: display }} />
                </button>
              );
            })}
          </div>
        )}
        <div className={styles.actions}>
          <Button size="small" onClick={() => finish(false)}>
            <T>Cancel</T>
          </Button>
          <Button type="submit" variant="primary" size="small">
            <T>Apply</T>
          </Button>
        </div>
      </form>
    </Popup>
  );
}
