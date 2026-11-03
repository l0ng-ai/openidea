import { useMemo } from "react";
import clsx from "clsx";
import { Icon, Input, type IconName } from "@/ui";
import { GENERATOR_ITEMS, type GeneratorDef, type GeneratorId } from "../types";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  activeId: GeneratorId;
  searchQuery: string;
  onSelect: (id: GeneratorId) => void;
  onSearchChange: (q: string) => void;
}

export function Sidebar({ activeId, searchQuery, onSelect, onSearchChange }: SidebarProps) {
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return GENERATOR_ITEMS;
    return GENERATOR_ITEMS.filter(
      (item) => item.name.toLowerCase().includes(q) || item.category.toLowerCase().includes(q),
    );
  }, [searchQuery]);

  const newProjectItems = filtered.filter((i) => i.category === "New Project");
  const generatorItems = filtered.filter((i) => i.category === "Generators");

  const renderItem = (item: GeneratorDef) => {
    const isActive = item.id === activeId;
    return (
      <button
        key={item.id}
        type="button"
        className={clsx(styles.item, isActive && styles.active)}
        onClick={() => onSelect(item.id)}
      >
        <span className={styles.itemIcon}>
          <Icon name={item.icon as IconName} size={16} />
        </span>
        <span>{item.name}</span>
      </button>
    );
  };

  return (
    <aside className={styles.sidebar}>
      <div className={styles.searchBox}>
        <Input
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search"
          className={styles.searchInput}
          aria-label="Search project types"
        />
      </div>

      <div className={styles.list}>
        {newProjectItems.length > 0 && (
          <>
            <div className={styles.groupTitle}>New Project</div>
            {newProjectItems.map(renderItem)}
          </>
        )}

        {generatorItems.length > 0 && (
          <>
            <div className={styles.groupTitle}>Generators</div>
            {generatorItems.map(renderItem)}
          </>
        )}
      </div>

      <div className={styles.footer}>
        <span
          className={styles.pluginLink}
          onClick={() => {
            alert("Plugin marketplace: More generators can be contributed via plugins.");
          }}
        >
          More via plugins…
        </span>
      </div>
    </aside>
  );
}
