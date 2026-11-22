/**
 * Per-session skills picker for the New Task and Session composers: shows every discovered skill
 * grouped by the folder it came from, lets the user turn skills off for this session only, reset
 * session overrides, or jump to Settings › Agents › Skills.
 */
import { useMemo } from "react";
import type { AgentSkillMode, AgentSkillState } from "@/bindings";
import { formatMessage, useTx } from "@/platform/i18n";
import { T } from "@/ui";
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
import {
  PickerEmpty,
  PickerGroupLabel,
  PickerPill,
  PickerRow,
  PickerSessionPill,
  PickerToggle,
  SessionPicker,
} from "./SessionPicker";

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
  return <PickerPill>{mode === "slashOnly" ? <T>/Slash</T> : <T>Auto</T>}</PickerPill>;
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
  const resolved = useMemo(() => resolveSessionSkills(skills, overrides ?? {}), [skills, overrides]);

  const handleToggleItem = (item: Pick<SessionSkillItem, "name" | "defaultMode">, nextEnabled: boolean) => {
    onChange(nextSkillOverrides(overrides, item, nextEnabled));
  };

  return (
    <SessionPicker
      icon="bulb"
      brand="Skills"
      triggerTitles={{
        plain: tx("Skills ({active}/{total} active)"),
        withOverrides: tx("Skills ({active}/{total} active · {overrides} session overrides)"),
      }}
      triggerAriaLabel={tx("Skills")}
      popupTitle={tx("Session Skills")}
      settingsTitle={tx("Skills…")}
      settingsPage={SKILLS_PAGE}
      counts={{ active: resolved.activeCount, total: resolved.totalCount, overrides: resolved.overrideCount }}
      search={{ placeholder: tx("Filter skills…"), ariaLabel: tx("Filter skills"), shown: resolved.totalCount > 5 }}
      disabled={disabled}
      busy={busy}
      openRequest={openRequest}
      hideTrigger={hideTrigger}
      refresh={testData ? undefined : () => void refreshSkillsCatalog(backend)}
      onReset={() => onChange({})}
      footerNote={
        provider !== normalizeProviderId(provider) && (
          <span>
            <T>This agent keeps its own / menu: off only stops OpenIDEA offering the skill.</T>
          </span>
        )
      }
    >
      {(query) => {
        const q = query.trim().toLowerCase();
        const matchesQuery = (item: SessionSkillItem) =>
          !q ||
          item.name.toLowerCase().includes(q) ||
          item.state.skill.description.toLowerCase().includes(q) ||
          item.state.skill.path.toLowerCase().includes(q);
        const groups = resolved.groups
          .map((group) => ({ ...group, items: group.items.filter(matchesQuery) }))
          .filter((group) => group.items.length > 0);
        return (
          <>
            {groups.map((group) => (
              <GroupRows key={group.source} source={group.source} items={group.items} onToggle={handleToggleItem} />
            ))}
            {groups.length === 0 && (
              <PickerEmpty>
                {resolved.totalCount === 0 ? <T>No skills found.</T> : <T>No matching skills.</T>}
              </PickerEmpty>
            )}
          </>
        );
      }}
    </SessionPicker>
  );
}

function GroupRows({
  source,
  items,
  onToggle,
}: {
  source: ResolvedSessionSkills["groups"][number]["source"];
  items: readonly SessionSkillItem[];
  onToggle: (item: SessionSkillItem, enabled: boolean) => void;
}) {
  const tx = useTx();
  const group = SKILL_SOURCE_GROUPS[source];
  return (
    <>
      <PickerGroupLabel title={group.paths}>{tx(group.label)}</PickerGroupLabel>
      {items.map((item) => (
        <SessionSkillRow key={item.name} item={item} onToggle={(on) => onToggle(item, on)} />
      ))}
    </>
  );
}

function SessionSkillRow({ item, onToggle }: { item: SessionSkillItem; onToggle: (enabled: boolean) => void }) {
  const tx = useTx();
  const { skill } = item.state;
  const description = skill.description;
  return (
    <PickerRow
      name={item.name}
      pills={
        <>
          <ModePill mode={item.mode} />
          {item.overridden && <PickerSessionPill />}
          {skill.contextFork && <PickerPill>fork</PickerPill>}
          {(skill.paths?.length ?? 0) > 0 && <PickerPill>paths</PickerPill>}
        </>
      }
      sub={description || undefined}
      subTitle={skill.paths?.length ? `${description} · ${skill.paths.join(", ")}` : description}
      controls={
        item.locked ? (
          <PickerPill>
            <T>Untrusted workspace</T>
          </PickerPill>
        ) : (
          <PickerToggle
            enabled={item.mode !== "off"}
            ariaLabel={formatMessage(tx("Enable {name} for this session"), { name: item.name })}
            onChange={onToggle}
          />
        )
      }
    />
  );
}
