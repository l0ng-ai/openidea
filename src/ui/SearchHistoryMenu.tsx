import { Menu, type MenuItem } from "./Menu";
import type { PopupAnchor } from "./Popup";
import { searchHistory } from "@/platform/search";

interface SearchHistoryMenuProps {
  kind: "find" | "replace" | null;
  anchor: PopupAnchor;
  onSelect: (value: string) => void;
  onClose: () => void;
}

export function SearchHistoryMenu({ kind, anchor, onSelect, onClose }: SearchHistoryMenuProps) {
  if (kind === null) return null;

  const replace = kind === "replace";
  const entries = searchHistory(kind);
  const items: MenuItem[] = entries.length
    ? entries.map((value) => ({
        label: value.replace(/\r\n?|\n/g, " ⏎ "),
        hint: value,
        verbatim: true,
        run: () => onSelect(value),
      }))
    : [{ label: replace ? "No recent replacements" : "No recent searches", disabled: true }];

  return (
    <Menu
      open
      anchor={anchor}
      title={replace ? "Recent Replacements" : "Recent Searches"}
      items={items}
      iconColumn={false}
      maxWidthOverAnchor={200}
      onClose={onClose}
    />
  );
}
