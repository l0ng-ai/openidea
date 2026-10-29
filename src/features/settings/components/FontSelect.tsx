/**
 * Font-family pickers over the families installed on this machine. The current
 * value always stays listed, so a family that isn't installed here (a synced
 * setting, an uninstalled font) still shows as selected.
 */
import { useMemo } from "react";
import type { SelectOption } from "@/ui";
import { BUNDLED_MONO_FAMILY } from "@/platform/fonts";
import { fontNames, useSystemFonts } from "@/platform/systemFonts";
import { Select } from "./Form";

const NO_BUNDLED: readonly string[] = [];
const MONO_BUNDLED: readonly string[] = [BUNDLED_MONO_FAMILY];

export interface FontSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** List only monospaced families (the current value stays). */
  monospacedOnly?: boolean;
  /** Offer "None" (empty value) first: fallback fonts. */
  none?: boolean;
  /** Families the app bundles, listed even when not installed. Default: the bundled monospace (none for fallbacks). */
  bundled?: readonly string[];
  disabled?: boolean;
  "aria-label": string;
}

export function FontSelect({
  value,
  onChange,
  monospacedOnly,
  none,
  bundled = none ? NO_BUNDLED : MONO_BUNDLED,
  disabled,
  ...aria
}: FontSelectProps) {
  const fonts = useSystemFonts();
  const options = useMemo<SelectOption[]>(() => {
    const names = fontNames(fonts, { monospacedOnly, include: [...bundled, value] });
    const list = names.map((n) => ({ value: n, label: n }));
    return none ? [{ value: "", label: "None" }, ...list] : list;
  }, [fonts, monospacedOnly, none, bundled, value]);
  return (
    <Select value={value} options={options} onChange={onChange} disabled={disabled} aria-label={aria["aria-label"]} />
  );
}
