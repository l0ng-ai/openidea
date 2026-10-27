/** IdeaVim's status bar widget: the current mode, and a menu to toggle Vim and reach its settings. */
import { useRef, useState } from "react";
import clsx from "clsx";
import { BarButton, Menu } from "@/ui";
import { modeLabel, useVimMode } from "./mode";
import { setVimEnabled, useVimSettings } from "./settings";
import styles from "./Vim.module.css";

export function VimStatus() {
  const enabled = useVimSettings((s) => s.enabled);
  const mode = useVimMode();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const label = enabled ? modeLabel(mode) : "Vim";
  return (
    <>
      <BarButton
        ref={ref}
        mono
        className={clsx(styles.status, !enabled && styles.off)}
        data-mode={enabled ? mode.mode : undefined}
        tooltip={enabled ? "Vim mode" : "Vim (disabled)"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </BarButton>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref}
        placement="top-end"
        aria-label="Vim"
        items={[
          { id: "enabled", label: "Enabled", checked: enabled, run: () => setVimEnabled(!enabled) },
          { kind: "separator" },
          { kind: "action", action: "vim.reloadRc", label: "Reload .ideavimrc" },
          { kind: "action", action: "vim.settings", label: "Settings…" },
        ]}
      />
    </>
  );
}
