/**
 * Per-session skills picker for the New Task and Session composers: shows every discovered skill
 * grouped by the folder it came from, lets the user turn skills off for this session only, reset
 * session overrides, or jump to Settings › Agents › Skills.
 */
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSkillMode, AgentSkillState } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { formatMessage, useTx } from "@/platform/i18n";
import { Icon, IconButton, Popup, SearchField, T, Toggle } from "@/ui";
import { SKILLS_PAGE } from "./model";
import { normalizeProviderId } from "./mcpModel";
import {
  SKILL_SOURCE_GROUPS,
  defaultSkillsBackend,
  nextSkillOverrides,
  refreshSkillsCatalog,
  resolveSessionSkills,
  useSkillsCatalog,
  useSkillsCatalogSync,
  type ResolvedSessionSkills,
  type SessionSkillItem,
  type SkillsBackend,
} from "./skillsModel";
import styles from "./SkillsPicker.module.css";

export interface SkillsPickerProps {
  provider: string;
  overrides: Readonly<Record<string, AgentSkillMode>> | undefined;
  onChange: (nextOverrides: Record<string, AgentSkillMode>) => void;
  disabled?: boolean;
  /** True while the session is actively running a turn (changes apply on the next turn). */
  busy?: boolean;
  /** Bumped when `/skills` is invoked from the composer to open this popover. */
  openRequest?: number;
  /** No button of its own: opened only through `openRequest`, above the composer. */
  hideTrigger?: boolean;
  /** Optional overrides for unit tests. */
  backend?: SkillsBackend;
  testData?: {
    skills: readonly AgentSkillState[];
  };
}

/** The mode pill a row shows: what the session runs the skill as. */
function ModePill({ mode }: { mode: AgentSkillMode }) {
  if (mode === "off") return null;
  return <span className={styles.pill}>{mode === "slashOnly" ? <T>/Slash</T> : <T>Auto</T>}</span>;
}

export function SkillsPicker({
  provider,
  overrides,
  onChange,
  disabled = false,
  busy = false,
  openRequest = 0,
  hideTrigger = false,
  backend = defaultSkillsBackend,
  testData,
}: SkillsPickerProps) {
  const tx = useTx();
  useSkillsCatalogSync(backend);
  const catalogSkills = useSkillsCatalog((s) => s.skills);

  const skills = testData?.skills ?? catalogSkills;

  const [open, setOpen] = useState(false);
  const [seenOpenRequest, setSeenOpenRequest] = useState(openRequest);
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLElement | null>(null);
  const setAnchor = (el: HTMLElement | null) => {
    anchor.current = el;
  };

  if (openRequest !== seenOpenRequest) {
    setSeenOpenRequest(openRequest);
    if (openRequest > 0 && !disabled) setOpen(true);
  }

  useEffect(() => {
    if (openRequest > 0 && !disabled && !testData) {
      void refreshSkillsCatalog(backend);
    }
  }, [openRequest, disabled, testData, backend]);

  const toggleOpen = () => {
    const next = !open;
    if (next && !testData) void refreshSkillsCatalog(backend);
    if (!next) setQuery("");
    setOpen(next);
  };

  const resolved = useMemo(() => resolveSessionSkills(skills, overrides ?? {}), [skills, overrides]);

  const q = query.trim().toLowerCase();
  const matchesQuery = (item: SessionSkillItem) =>
    !q ||
    item.name.toLowerCase().includes(q) ||
    item.state.skill.description.toLowerCase().includes(q) ||
    item.state.skill.path.toLowerCase().includes(q);

  const groups = resolved.groups
    .map((group) => ({ ...group, items: group.items.filter(matchesQuery) }))
    .filter((group) => group.items.length > 0);

  const countLabel =
    resolved.totalCount === 0
      ? "0"
      : resolved.activeCount === resolved.totalCount
        ? String(resolved.activeCount)
        : `${resolved.activeCount}/${resolved.totalCount}`;

  const handleToggleItem = (item: Pick<SessionSkillItem, "name" | "defaultMode">, nextEnabled: boolean) => {
    onChange(nextSkillOverrides(overrides, item, nextEnabled));
  };

  return (
    <>
      {hideTrigger ? (
        // Pinned to the composer's bottom-right corner: the popover opens under the box, like its other pickers.
        <span ref={setAnchor} className={styles.hiddenAnchor} aria-hidden />
      ) : (
        <button
          ref={setAnchor}
          type="button"
          disabled={disabled}
          className={styles.trigger}
          title={
            resolved.overrideCount > 0
              ? formatMessage(tx("Skills ({active}/{total} active · {overrides} session overrides)"), {
                  active: resolved.activeCount,
                  total: resolved.totalCount,
                  overrides: resolved.overrideCount,
                })
              : formatMessage(tx("Skills ({active}/{total} active)"), {
                  active: resolved.activeCount,
                  total: resolved.totalCount,
                })
          }
          aria-label={tx("Skills")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          <Icon name="bulb" size={13} />
          <span className={styles.triggerLabel}>Skills</span>
          <span className={styles.triggerCount}>{countLabel}</span>
          {resolved.overrideCount > 0 && <span className={styles.overrideDot} aria-hidden />}
        </button>
      )}

      <Popup
        open={open}
        anchor={anchor}
        placement={hideTrigger ? "bottom-end" : "top-start"}
        offset={6}
        onClose={() => {
          setOpen(false);
          setQuery("");
        }}
        aria-label={tx("Session Skills")}
        className={styles.popup}
      >
        <div className={styles.header}>
          <span className={styles.title}>
            <T>Session Skills</T>
          </span>
          <div className={styles.headerActions}>
            {resolved.overrideCount > 0 && (
              <button type="button" className={styles.resetBtn} onClick={() => onChange({})}>
                <T>Reset</T>
              </button>
            )}
            <IconButton
              icon="settings"
              size="small"
              title={tx("Skills…")}
              aria-label={tx("Skills…")}
              onClick={() => {
                setOpen(false);
                void executeAction("file.settings", SKILLS_PAGE);
              }}
            />
          </div>
        </div>

        {resolved.totalCount > 5 && (
          <div className={styles.searchWrap}>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder={tx("Filter skills…")}
              aria-label={tx("Filter skills")}
            />
          </div>
        )}

        <div className={styles.list}>
          {groups.map((group) => (
            <GroupRows
              key={group.source}
              source={group.source}
              items={group.items}
              onToggle={(item, on) => handleToggleItem(item, on)}
              onOpenSettings={() => {
                setOpen(false);
                void executeAction("file.settings", SKILLS_PAGE);
              }}
            />
          ))}
          {groups.length === 0 && (
            <div className={styles.empty}>
              {resolved.totalCount === 0 ? <T>No skills found.</T> : <T>No matching skills.</T>}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <span>
            {busy ? <T>Changes apply on the next message.</T> : <T>Toggles here apply to this session only.</T>}
          </span>
          {provider !== normalizeProviderId(provider) && (
            <span>
              <T>This agent keeps its own / menu: off only stops OpenIDEA offering the skill.</T>
            </span>
          )}
        </div>
      </Popup>
    </>
  );
}

function GroupRows({
  source,
  items,
  onToggle,
  onOpenSettings,
}: {
  source: ResolvedSessionSkills["groups"][number]["source"];
  items: readonly SessionSkillItem[];
  onToggle: (item: SessionSkillItem, enabled: boolean) => void;
  onOpenSettings: () => void;
}) {
  const tx = useTx();
  const group = SKILL_SOURCE_GROUPS[source];
  return (
    <>
      <div className={styles.groupLabel} title={group.paths}>
        {tx(group.label)}
      </div>
      {items.map((item) => (
        <SessionSkillRow
          key={item.name}
          item={item}
          onToggle={(on) => onToggle(item, on)}
          onOpenSettings={onOpenSettings}
        />
      ))}
    </>
  );
}

function SessionSkillRow({
  item,
  onToggle,
  onOpenSettings,
}: {
  item: SessionSkillItem;
  onToggle: (enabled: boolean) => void;
  onOpenSettings: () => void;
}) {
  const tx = useTx();
  // The settings decide a skill that is off by default; the session only ever turns active skills off.
  const locked = item.defaultMode === "off";
  const enabled = item.mode !== "off";
  return (
    <div className={styles.row}>
      <div className={styles.rowInfo}>
        <div className={styles.rowTitle}>
          <span className={styles.name}>{item.name}</span>
          <ModePill mode={item.mode} />
          {item.overridden && (
            <span className={clsx(styles.pill, styles.pillSession)}>
              <T>Session</T>
            </span>
          )}
        </div>
        {item.state.skill.description && (
          <span className={styles.sub} title={item.state.skill.description}>
            {item.state.skill.description}
          </span>
        )}
      </div>
      <div className={styles.rowControls}>
        {locked ? (
          <button type="button" className={styles.inlineLink} onClick={onOpenSettings}>
            <T>Enable in Settings</T>
          </button>
        ) : (
          <>
            <Toggle
              checked={enabled}
              aria-label={formatMessage(tx("Enable {name} for this session"), { name: item.name })}
              onChange={onToggle}
            />
            <span className={clsx(styles.dot, enabled && styles.dotOn)} aria-hidden />
          </>
        )}
      </div>
    </div>
  );
}
