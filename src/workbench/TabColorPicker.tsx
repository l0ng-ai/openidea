import { useState } from "react";
import { create } from "zustand";
import { useTx } from "@/platform/i18n";
import { Popup } from "@/ui";
import { projectColorIndex, projectColorSlotVars } from "./projectColor";
import { setTabColorOverride, tabColorOverride } from "./tabColors";
import styles from "./TabColorPicker.module.css";

export interface TabColorTarget {
  root: string;
  name: string;
  x: number;
  y: number;
}

export const useTabColorPicker = create<{ target: TabColorTarget | null }>(() => ({ target: null }));

export function openTabColorPicker(target: TabColorTarget): void {
  useTabColorPicker.setState({ target });
}

const PRESETS = [
  { slot: "1", label: "Orange" },
  { slot: "2", label: "Yellow" },
  { slot: "3", label: "Olive" },
  { slot: "4", label: "Cyan" },
  { slot: "5", label: "Blue" },
  { slot: "6", label: "Rose" },
  { slot: "7", label: "Violet" },
  { slot: "8", label: "Teal" },
  { slot: "9", label: "Green" },
];

const HEX_COLOR = /^#[0-9a-f]{6}$/;

export function TabColorPicker() {
  const target = useTabColorPicker((s) => s.target);
  if (!target) return null;
  return <Panel key={target.root} target={target} />;
}

function Panel({ target }: { target: TabColorTarget }) {
  const tx = useTx();
  const [override, setOverride] = useState(() => tabColorOverride(target.root));
  const [hex, setHex] = useState(override?.startsWith("#") ? override : "");
  const close = () => useTabColorPicker.setState({ target: null });
  const apply = (value: string | null) => {
    setTabColorOverride(target.root, value);
    setOverride(value);
  };
  const custom = override !== null && override.startsWith("#");
  const current = override ?? String(projectColorIndex(target.name));

  return (
    <Popup
      open
      anchor={{ x: target.x, y: target.y }}
      onClose={close}
      aria-label={tx("Project Color")}
      className={styles.panel}
      trapFocus
    >
      <div className={styles.swatches} role="radiogroup" aria-label={tx("Project Color")}>
        {PRESETS.map((p, i) => {
          const on = current === p.slot;
          return (
            <button
              key={p.slot}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={tx(p.label)}
              title={tx(p.label)}
              className={`${styles.swatch} ${on ? styles.swatchOn : ""}`}
              onClick={() => {
                apply(p.slot);
                close();
              }}
            >
              <span
                className={styles.swatchColor}
                style={{ background: projectColorSlotVars(i + 1)["--project-color"] }}
              />
            </button>
          );
        })}
        <label
          className={`${styles.swatch} ${custom ? styles.swatchOn : ""}`}
          role="radio"
          aria-checked={custom}
          title={tx("Custom colour")}
        >
          <span className={styles.swatchColor} style={custom ? { background: override } : undefined} />
          <input
            type="color"
            className={styles.colorNative}
            aria-label={tx("Custom colour")}
            value={custom && HEX_COLOR.test(override) ? override : "#808080"}
            onChange={(e) => apply(e.target.value)}
          />
        </label>
      </div>
      <div className={styles.footer}>
        <input
          className={`${styles.hex} ${hex !== "" && !HEX_COLOR.test(hex) ? styles.hexInvalid : ""}`}
          placeholder="#rrggbb"
          aria-label={tx("Custom colour hex")}
          value={hex}
          onChange={(e) => {
            setHex(e.target.value);
            if (HEX_COLOR.test(e.target.value)) apply(e.target.value.toLowerCase());
          }}
        />
        <button
          type="button"
          className={styles.reset}
          onClick={() => {
            apply(null);
            close();
          }}
        >
          {tx("Reset to Default")}
        </button>
      </div>
    </Popup>
  );
}
