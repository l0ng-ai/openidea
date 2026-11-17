import { useEffect, useMemo, useRef, useState } from "react";
import { onActionExecuted } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { validateSettings } from "../model/schema";
import { presentAction, type PresentedAction } from "./presentation";
import styles from "./PresentationAssistant.module.css";

const FADE_MS = 300;

/** Appearance › Presentation Assistant: the name and shortcut of each action the user runs. */
export function PresentationAssistant() {
  const raw = useProject((s) => s.settings);
  const settings = useMemo(() => validateSettings(raw).appearance.presentationAssistant, [raw]);
  const [shown, setShown] = useState<{ action: PresentedAction; key: number; leaving: boolean } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const { enabled, durationSeconds, alternateKeymap } = settings;

  useEffect(() => {
    if (!enabled) return;
    let key = 0;
    const clear = () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    };
    const off = onActionExecuted((id) => {
      const action = presentAction(id, alternateKeymap);
      if (!action) return;
      clear();
      const current = ++key;
      setShown({ action, key: current, leaving: false });
      const hold = Math.max(0, durationSeconds * 1000 - FADE_MS);
      timers.current.push(
        setTimeout(() => setShown((s) => (s?.key === current ? { ...s, leaving: true } : s)), hold),
        setTimeout(() => setShown((s) => (s?.key === current ? null : s)), hold + FADE_MS),
      );
    });
    return () => {
      off();
      clear();
      // A popup whose timers were just cleared would otherwise stay up.
      setShown(null);
    };
  }, [enabled, durationSeconds, alternateKeymap]);

  if (!enabled || !shown) return null;
  const { action, leaving } = shown;
  return (
    <div
      className={[styles.popup, styles[settings.size], styles[settings.position], leaving && styles.leaving]
        .filter(Boolean)
        .join(" ")}
      role="status"
      aria-live="polite"
      data-testid="presentation-assistant"
    >
      <span className={styles.title}>{action.title}</span>
      {action.shortcut && <span className={styles.shortcut}>{action.shortcut}</span>}
      {action.alternate && (
        <span className={styles.keymap}>
          {action.alternate.shortcut} ({action.alternate.keymap})
        </span>
      )}
    </div>
  );
}
