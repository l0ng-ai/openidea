/**
 * Settings › Plugins, laid out like IDEA: Available / Installed tabs with a
 * gear menu, a searchable list on the left (enable checkboxes) and the
 * selected plugin's details on the right (Overview / What's New).
 *
 * There is no network repository: Available lists the plugin packages
 * available locally (`plugin_catalog`) and installs them from disk.
 */
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import clsx from "clsx";
import type { CapabilityInfo, CatalogPlugin, MarketPlugin, PluginInfo, PluginStatus } from "@/bindings";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Icon,
  IconButton,
  SearchField,
  Select,
  Spinner,
  Tabs,
  showContextMenu,
  type MenuItem,
  T,
} from "@/ui";
import { RISK_LABEL, sortByRisk } from "./consent";
import { itemsOf, uiPoint } from "./projection";
import {
  compareVersions,
  isUpdate,
  grantPlugin,
  installFromDisk,
  installFromMarket,
  refreshMarket,
  rollBackPlugin,
  setMarketUrl,
  refreshCatalog,
  refreshPlugins,
  reloadPlugin,
  setAllInstalledEnabled,
  setPluginCapability,
  setPluginEnabled,
  uninstallPlugin,
  updateAllPlugins,
  usePlugins,
} from "./store";
import { useProject } from "@/platform/project";
import { importIntellijTheme, showInstalledIntellijThemes } from "./intellijImport";
import { promptInput } from "@/workbench/inputDialogs";
import styles from "./PluginsPage.module.css";
import { tx } from "@/platform/i18n";

const STATUS: Record<PluginStatus, { label: string; tone: "success" | "accent" | "neutral" | "danger" | "warning" }> = {
  active: { label: "Running", tone: "success" },
  inactive: { label: "Enabled", tone: "accent" },
  static: { label: "Enabled", tone: "accent" },
  disabled: { label: "Disabled", tone: "neutral" },
  needsConsent: { label: "Needs permission", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};

/** Human names of the built-in contribution points (others show their id). */
const POINT_TITLES: Record<string, string> = {
  commands: "Commands",
  themes: "Themes",
  iconThemes: "File Icon Themes",
  languages: "Languages",
  providers: "Editor Providers",
};

const pointTitle = (point: string) => uiPoint(point)?.title ?? POINT_TITLES[point] ?? point;

export const NO_REPOSITORY = "There is no online plugin repository";

type Tab = "marketplace" | "installed";

const matches = (texts: readonly (string | null | undefined)[], q: string) =>
  texts.some((s) => !!s && s.toLowerCase().includes(q));

export function filterPlugins(plugins: readonly PluginInfo[], query: string): PluginInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...plugins];
  return plugins.filter((p) =>
    matches([p.name, p.id, p.description, ...p.authors, ...p.contributions.map((c) => c.label)], q),
  );
}

export function filterCatalog(catalog: readonly CatalogPlugin[], query: string): CatalogPlugin[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...catalog];
  return catalog.filter((p) => matches([p.name, p.id, p.description, ...p.authors], q));
}

/** What the Available tab offers for a catalog package given what is installed. */
export function catalogState(
  entry: CatalogPlugin,
  installed: readonly PluginInfo[],
): "install" | "update" | "installed" | "dev" {
  const have = installed.find((p) => p.id === entry.id);
  if (!have) return "install";
  if (have.source !== "installed") return "dev";
  return compareVersions(entry.version, have.version) > 0 ? "update" : "installed";
}

const vendorOf = (authors: readonly string[]) => authors.join(", ");

function PluginIcon({ large }: { large?: boolean }) {
  return (
    <span className={clsx(styles.icon, large && styles.iconLarge)} aria-hidden>
      <Icon name="plugin" size={large ? 32 : 20} />
    </span>
  );
}

function ListHeader({ title, count }: { title: string; count: number }) {
  return (
    <li className={styles.groupHeader} aria-hidden>
      <span>{title}</span>
      <span className={styles.groupCount}>{count}</span>
    </li>
  );
}

function InstalledRow({ plugin, selected, onSelect }: { plugin: PluginInfo; selected: boolean; onSelect: () => void }) {
  const busy = usePlugins((s) => !!s.busy[plugin.id]);
  return (
    <li className={clsx(styles.row, selected && styles.rowSelected, !plugin.enabled && styles.rowDisabled)}>
      <button
        type="button"
        className={styles.rowMain}
        aria-current={selected || undefined}
        onClick={onSelect}
        title={plugin.description || plugin.name}
      >
        <PluginIcon />
        <span className={styles.rowText}>
          <span className={styles.rowName}>{plugin.name}</span>
          <span className={styles.rowMeta}>
            <span className={styles.rowVendor}>{vendorOf(plugin.authors) || plugin.id}</span>
            <span>{plugin.version}</span>
            {plugin.source !== "installed" && (
              <span className={styles.devTag}>{plugin.source === "linked" ? tx("linked") : tx("dev")}</span>
            )}
            {plugin.status === "failed" && (
              <Badge dot tone="danger">
                <T>Failed</T>
              </Badge>
            )}
            {plugin.status === "needsConsent" && (
              <Badge dot tone="warning">
                <T>Needs permission</T>
              </Badge>
            )}
          </span>
        </span>
      </button>
      <Checkbox
        className={styles.rowCheck}
        checked={plugin.enabled}
        disabled={busy}
        onChange={(on) => void setPluginEnabled(plugin.id, on)}
        aria-label={plugin.enabled ? tx`Disable ${plugin.name}` : tx`Enable ${plugin.name}`}
      />
    </li>
  );
}

function CatalogButton({ entry, compact }: { entry: CatalogPlugin; compact?: boolean }) {
  const plugins = usePlugins((s) => s.plugins);
  const installing = usePlugins((s) => s.installing);
  const state = catalogState(entry, plugins);
  if (state === "installed" || state === "dev") {
    return <span className={styles.installedTag}>{state === "dev" ? tx("Dev plugin loaded") : tx("Installed")}</span>;
  }
  const label = state === "update" ? "Update" : "Install";
  return (
    <Button
      size="small"
      variant={compact ? "secondary" : "primary"}
      disabled={installing || !!entry.problem}
      title={entry.problem ?? undefined}
      aria-label={`${label} ${entry.name}`}
      onClick={(e) => {
        e.stopPropagation();
        void installFromDisk(entry.path);
      }}
    >
      {label}
    </Button>
  );
}

function CatalogRow({ entry, selected, onSelect }: { entry: CatalogPlugin; selected: boolean; onSelect: () => void }) {
  return (
    <li className={clsx(styles.row, selected && styles.rowSelected)}>
      <button
        type="button"
        className={styles.rowMain}
        aria-current={selected || undefined}
        onClick={onSelect}
        title={entry.description || entry.name}
      >
        <PluginIcon />
        <span className={styles.rowText}>
          <span className={styles.rowName}>{entry.name}</span>
          <span className={styles.rowMeta}>
            <span className={styles.rowVendor}>{vendorOf(entry.authors) || entry.id}</span>
            <span>{entry.version}</span>
          </span>
        </span>
      </button>
      <CatalogButton entry={entry} compact />
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

function DetailTabs({ notes, overview }: { notes: string | null; overview: ReactNode }) {
  const [tab, setTab] = useState<"overview" | "whatsNew">("overview");
  return (
    <>
      <Tabs
        variant="compact"
        className={styles.detailTabs}
        aria-label="Plugin details"
        activeId={tab}
        onSelect={(id) => setTab(id as typeof tab)}
        items={[
          { id: "overview", label: "Overview" },
          { id: "whatsNew", label: "What's New" },
        ]}
      />
      {tab === "overview" ? (
        overview
      ) : notes ? (
        <pre className={styles.notes}>{notes.trim()}</pre>
      ) : (
        <p className={styles.muted}>
          <T>This version has no release notes.</T>
        </p>
      )}
    </>
  );
}

/** Contribution points of a plugin, in the order they were committed. */
function pointsOf(plugin: PluginInfo): string[] {
  return [...new Set(plugin.contributions.map((c) => c.point))];
}

function PointSection({ plugin, point }: { plugin: PluginInfo; point: string }) {
  const ui = usePlugins((s) => s.ui);
  const Details = uiPoint(point)?.Details;
  const items = itemsOf(ui, point, plugin.id);
  return (
    <Section title={pointTitle(point)}>
      {Details && items.length > 0 ? (
        <Details plugin={plugin} items={items as never} />
      ) : (
        <ul className={styles.items}>
          {plugin.contributions
            .filter((c) => c.point === point)
            .map((c, i) => (
              <li key={`${c.label}-${i}`} className={styles.item}>
                <span className={styles.itemMain}>{c.label}</span>
              </li>
            ))}
        </ul>
      )}
    </Section>
  );
}

function CapabilityRow({ cap, children }: { cap: CapabilityInfo; children?: ReactNode }) {
  return (
    <li className={styles.item}>
      {children}
      <span className={styles.itemMain}>{cap.description}</span>
      <span className={styles.mono}>{cap.id}</span>
      <Badge tone={RISK_LABEL[cap.risk].tone}>{RISK_LABEL[cap.risk].label}</Badge>
    </li>
  );
}

function CapabilityList({ plugin, busy }: { plugin: PluginInfo; busy: boolean }) {
  if (plugin.capabilities.length === 0) {
    return (
      <div className={styles.muted}>
        <T>No special permissions.</T>
      </div>
    );
  }
  const confirmed = plugin.status !== "needsConsent";
  return (
    <ul className={styles.items} aria-label={tx("Permissions")}>
      {sortByRisk(plugin.capabilities).map((c) => (
        <CapabilityRow key={c.id} cap={c}>
          <Checkbox
            checked={c.granted}
            disabled={busy || !confirmed}
            onChange={(on) => void setPluginCapability(plugin.id, c.id, on)}
            aria-label={c.granted ? tx`Revoke ${c.id}` : tx`Allow ${c.id}`}
          />
        </CapabilityRow>
      ))}
    </ul>
  );
}

function InstalledDetails({ plugin }: { plugin: PluginInfo }) {
  const busy = usePlugins((s) => !!s.busy[plugin.id]);
  const status = STATUS[plugin.status];
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const overview = (
    <>
      {plugin.error && (
        <div className={styles.error} role="alert">
          {plugin.error}
        </div>
      )}
      {plugin.description && <p className={styles.description}>{plugin.description}</p>}

      <dl className={styles.facts}>
        <dt>
          <T>Id</T>
        </dt>
        <dd className={styles.mono}>{plugin.id}</dd>
        <dt>
          <T>Location</T>
        </dt>
        <dd className={styles.mono} title={plugin.path}>
          {plugin.path}
        </dd>
        <dt>
          <T>Code</T>
        </dt>
        <dd>{plugin.hasCode ? tx("WebAssembly component (sandboxed)") : tx("None — contributions only")}</dd>
        {plugin.homepage && (
          <>
            <dt>
              <T>Homepage</T>
            </dt>
            <dd className={styles.mono}>{plugin.homepage}</dd>
          </>
        )}
      </dl>

      {plugin.status === "needsConsent" && (
        <div className={styles.consentNotice} role="note">
          <span>
            {plugin.source === "installed"
              ? tx("This version asks for new permissions. It stays off until you allow them.")
              : tx("Plugins from a project folder run only after you allow them.")}
          </span>
          <Button size="small" variant="primary" disabled={busy} onClick={() => void grantPlugin(plugin.id)}>
            <T>Review Permissions…</T>
          </Button>
        </div>
      )}

      {plugin.warnings.map((w) => (
        <div key={w} className={styles.muted}>
          {w}
        </div>
      ))}

      <Section title="Permissions">
        <CapabilityList plugin={plugin} busy={busy} />
      </Section>

      {pointsOf(plugin).map((point) => (
        <PointSection key={point} plugin={plugin} point={point} />
      ))}

      {plugin.hasCode && plugin.stats.activations > 0 && (
        <Section title="Statistics">
          <div className={styles.muted}>
            {tx`Activated ${plugin.stats.activations}× (last in ${(plugin.stats.activationMs ?? 0).toFixed(1)} ms), ${plugin.stats.calls} calls, ${plugin.stats.errors} errors, slowest ${(plugin.stats.maxCallMs ?? 0).toFixed(1)} ms`}
          </div>
          <div className={styles.muted}>
            {tx`Recent calls p95 ${(plugin.stats.p95CallMs ?? 0).toFixed(1)} ms; ${plugin.stats.crashes} crashes, ${plugin.stats.slowCalls} editor results too late, reclaimed ${plugin.stats.reclaims}× when idle`}
          </div>
        </Section>
      )}
    </>
  );

  return (
    <div className={styles.details} aria-label={`${plugin.name} details`}>
      <header className={styles.header}>
        <PluginIcon large />
        <div className={styles.headerText}>
          <h2 className={styles.title}>{plugin.name}</h2>
          {plugin.authors.length > 0 && <div className={styles.authors}>{vendorOf(plugin.authors)}</div>}
          <div className={styles.titleLine}>
            <span className={styles.version}>{plugin.version}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
            {plugin.source !== "installed" && (
              <Badge tone="warning">{plugin.source === "linked" ? tx("Linked plugin") : tx("Project plugin")}</Badge>
            )}
            {plugin.source === "installed" &&
              (plugin.publisher ? (
                <Badge tone="success">{tx`Signed by ${plugin.publisher}`}</Badge>
              ) : (
                <Badge tone="neutral">{tx("Unsigned")}</Badge>
              ))}
          </div>
        </div>
        <div className={styles.headerActions}>
          {busy && <Spinner size={14} label="Working" />}
          <Button
            size="small"
            variant={plugin.enabled ? "secondary" : "primary"}
            disabled={busy}
            // Enabling an enabled plugin stops and starts it again: that is "Restart".
            onClick={() => void setPluginEnabled(plugin.id, !plugin.enabled || plugin.status === "failed")}
          >
            {plugin.enabled ? (plugin.status === "failed" ? "Restart" : "Disable") : "Enable"}
          </Button>
          <IconButton
            icon="refresh"
            title="Reload from disk"
            disabled={busy}
            onClick={() => void reloadPlugin(plugin.id)}
          />
          {plugin.previousVersion && (
            <Button size="small" disabled={busy} onClick={() => void rollBackPlugin(plugin.id)}>
              {tx`Roll Back to ${plugin.previousVersion}`}
            </Button>
          )}
          {plugin.source === "installed" &&
            (confirmUninstall ? (
              <>
                <Button
                  size="small"
                  variant="primary"
                  disabled={busy}
                  onClick={() => void uninstallPlugin(plugin.id)}
                  aria-label={tx`Confirm uninstall ${plugin.name}`}
                >
                  <T>Uninstall</T>
                </Button>
                <Button size="small" variant="ghost" onClick={() => setConfirmUninstall(false)}>
                  <T>Cancel</T>
                </Button>
              </>
            ) : (
              <Button size="small" disabled={busy} onClick={() => setConfirmUninstall(true)}>
                <T>Uninstall…</T>
              </Button>
            ))}
        </div>
      </header>
      <DetailTabs notes={plugin.changeNotes} overview={overview} />
    </div>
  );
}

function CatalogDetails({ entry }: { entry: CatalogPlugin }) {
  const contributes = entry.contributions.map((c) => `${pointTitle(c.point)}: ${c.count}`);
  const overview = (
    <>
      {entry.problem && (
        <div className={styles.error} role="alert">
          {entry.problem}
        </div>
      )}
      {entry.description && <p className={styles.description}>{entry.description}</p>}
      <dl className={styles.facts}>
        <dt>
          <T>Id</T>
        </dt>
        <dd className={styles.mono}>{entry.id}</dd>
        <dt>
          <T>Source</T>
        </dt>
        <dd className={styles.mono} title={entry.path}>
          {entry.path}
        </dd>
        <dt>
          <T>Code</T>
        </dt>
        <dd>{entry.hasCode ? tx("WebAssembly component (sandboxed)") : tx("None — contributions only")}</dd>
        {contributes.length > 0 && (
          <>
            <dt>
              <T>Contributes</T>
            </dt>
            <dd>{contributes.join(", ")}</dd>
          </>
        )}
      </dl>
      {entry.capabilities.length > 0 && (
        <Section title="Permissions">
          <ul className={styles.items}>
            {sortByRisk(entry.capabilities).map((c) => (
              <CapabilityRow key={c.id} cap={c} />
            ))}
          </ul>
        </Section>
      )}
    </>
  );
  return (
    <div className={styles.details} aria-label={`${entry.name} details`}>
      <header className={styles.header}>
        <PluginIcon large />
        <div className={styles.headerText}>
          <h2 className={styles.title}>{entry.name}</h2>
          {entry.authors.length > 0 && <div className={styles.authors}>{vendorOf(entry.authors)}</div>}
          <div className={styles.titleLine}>
            <span className={styles.version}>{entry.version}</span>
          </div>
        </div>
        <div className={styles.headerActions}>
          <CatalogButton entry={entry} />
        </div>
      </header>
      <DetailTabs notes={entry.changeNotes} overview={overview} />
    </div>
  );
}

interface GearActions {
  /** Installing needs a trusted project's window (the host refuses it elsewhere). */
  canImport: boolean;
  install: (packageFile: boolean) => void;
  importIntellijFile: () => void;
  importInstalledIntellij: () => void;
  editRepository: () => void;
}

/** Asks for the marketplace index URL; an empty one restores the default. */
async function editMarketUrl() {
  const url = await promptInput({
    title: "Plugin Repository",
    label: "Marketplace index URL:",
    initial: usePlugins.getState().marketUrl ?? "",
    placeholder: "https://…/index.json or a folder path",
    okLabel: "Save",
    validate: () => null,
    hint: <T>Leave empty to use the default repository.</T>,
  });
  if (url !== null) await setMarketUrl(url);
}

function gearMenu(plugins: readonly PluginInfo[], updates: number, actions: GearActions): MenuItem[] {
  const installed = plugins.filter((p) => p.source === "installed");
  return [
    {
      label: updates > 0 ? tx`Update All Plugins (${updates})` : "Update All Plugins",
      disabled: updates === 0,
      run: () => void updateAllPlugins(),
    },
    { kind: "separator" },
    { label: "Install Plugin from Disk…", icon: "package", run: () => actions.install(false) },
    { label: "Install Plugin from Package File…", run: () => actions.install(true) },
    { label: "Plugin Repository…", run: actions.editRepository },
    ...(actions.canImport
      ? [
          { kind: "separator" as const },
          { label: "Import Theme from IntelliJ IDE…", run: actions.importInstalledIntellij },
          { label: "Import IntelliJ Theme from File…", run: actions.importIntellijFile },
        ]
      : []),
    { kind: "separator" },
    {
      label: "Disable All Downloaded Plugins",
      disabled: !installed.some((p) => p.enabled),
      run: () => void setAllInstalledEnabled(false),
    },
    {
      label: "Enable All Downloaded Plugins",
      disabled: !installed.some((p) => !p.enabled),
      run: () => void setAllInstalledEnabled(true),
    },
    { kind: "separator" },
    {
      label: "Rescan Plugins",
      icon: "refresh",
      run: () => {
        void refreshPlugins();
        void refreshCatalog();
        void refreshMarket(true);
      },
    },
  ];
}

const CATEGORIES = [
  "languages",
  "themes",
  "icon-themes",
  "linters",
  "vcs",
  "ai",
  "frameworks",
  "tools",
  "other",
] as const;
type Category = (typeof CATEGORIES)[number];

function categoryLabel(c: Category): string {
  switch (c) {
    case "languages":
      return tx("Languages");
    case "themes":
      return tx("Themes");
    case "icon-themes":
      return tx("Icon Themes");
    case "linters":
      return tx("Linters & Formatters");
    case "vcs":
      return tx("Version Control");
    case "ai":
      return tx("AI");
    case "frameworks":
      return tx("Frameworks");
    case "tools":
      return tx("Tools");
    case "other":
      return tx("Other");
  }
}

/** A marketplace plugin's categories this IDE knows; `other` without any. */
function categoriesOf(m: MarketPlugin): Category[] {
  const known = CATEGORIES.filter((c) => m.categories?.includes(c));
  return known.length > 0 ? known : ["other"];
}

/** Filters the marketplace by category; lists the categories that have plugins. */
function CategoryFilter({
  market,
  value,
  onChange,
}: {
  market: readonly MarketPlugin[];
  value: Category | "all";
  onChange: (value: Category | "all") => void;
}) {
  const counts = new Map<Category, number>();
  for (const m of market) for (const c of categoriesOf(m)) counts.set(c, (counts.get(c) ?? 0) + 1);
  const options = [
    { value: "all" as const, label: tx("All Categories"), detail: String(market.length) },
    ...CATEGORIES.filter((c) => counts.has(c)).map((c) => ({
      value: c,
      label: categoryLabel(c),
      detail: String(counts.get(c)),
    })),
  ];
  return (
    <Select
      aria-label={tx("Category")}
      className={styles.categorySelect}
      value={value}
      options={options}
      onChange={onChange}
    />
  );
}

function MarketRow({ entry, selected, onSelect }: { entry: MarketPlugin; selected: boolean; onSelect: () => void }) {
  const update = isUpdate(entry);
  return (
    <li className={clsx(styles.row, selected && styles.rowSelected)}>
      <button
        type="button"
        className={styles.rowMain}
        aria-current={selected || undefined}
        onClick={onSelect}
        title={entry.description || entry.name}
      >
        <PluginIcon />
        <span className={styles.rowText}>
          <span className={styles.rowName}>{entry.name}</span>
          <span className={styles.rowMeta}>
            <span className={styles.rowVendor}>{entry.publisher}</span>
            <span>{entry.version}</span>
          </span>
        </span>
      </button>
      {update ? (
        <Badge tone="accent">{tx("Update")}</Badge>
      ) : entry.installed ? (
        <Badge tone="neutral">{tx("Installed")}</Badge>
      ) : !entry.compatible ? (
        <Badge tone="warning">{tx("Incompatible")}</Badge>
      ) : null}
    </li>
  );
}

function MarketDetails({ entry, onInstalled }: { entry: MarketPlugin; onInstalled: (id: string) => void }) {
  const installing = usePlugins((s) => s.installing);
  const update = isUpdate(entry);
  const install = async () => {
    const id = await installFromMarket(entry.id);
    if (id) onInstalled(id);
  };
  return (
    <div className={styles.details} aria-label={`${entry.name} details`}>
      <header className={styles.header}>
        <PluginIcon large />
        <div className={styles.headerText}>
          <h2 className={styles.title}>{entry.name}</h2>
          <div className={styles.authors}>{entry.authors?.length ? vendorOf(entry.authors) : entry.publisher}</div>
          <div className={styles.titleLine}>
            <span className={styles.version}>{entry.version}</span>
            <Badge tone="success">{tx`Signed by ${entry.publisher}`}</Badge>
          </div>
        </div>
        <div className={styles.headerActions}>
          {entry.compatible && (!entry.installed || update) && (
            <Button size="small" variant="primary" disabled={installing} onClick={() => void install()}>
              {update ? tx`Update to ${entry.version}` : tx("Install")}
            </Button>
          )}
        </div>
      </header>
      <div className={styles.marketOverview}>
        {!entry.compatible && (
          <p className={clsx(styles.notice, styles.detailsNotice)} role="note">
            <Icon name="info" size={14} />
            <span>{tx`Needs plugin API ${entry.engine}. Update OpenIDEA to install it.`}</span>
          </p>
        )}
        {entry.description && <p className={styles.description}>{entry.description}</p>}
        <dl className={styles.facts}>
          <dt>
            <T>Id</T>
          </dt>
          <dd className={styles.mono}>{entry.id}</dd>
          <dt>
            <T>Category</T>
          </dt>
          <dd>{categoriesOf(entry).map(categoryLabel).join(", ")}</dd>
          {entry.installed && (
            <>
              <dt>
                <T>Installed</T>
              </dt>
              <dd>{entry.installed}</dd>
            </>
          )}
        </dl>
        {(entry.capabilities?.length ?? 0) > 0 && (
          <Section title="Permissions">
            <ul className={styles.items}>
              {(entry.capabilities ?? []).map((c) => (
                <li key={c} className={clsx(styles.item, styles.mono)}>
                  {c}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}

export function PluginsPage() {
  const { plugins, loaded, loading, error, installing, catalog, catalogError, market, marketUrl, marketError } =
    usePlugins();
  const [tab, setTab] = useState<Tab>("installed");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>(null);

  useEffect(() => {
    void refreshPlugins();
    void refreshCatalog();
    void refreshMarket(false);
  }, []);
  const [selectedMarketId, setSelectedMarketId] = useState<string | null>(null);
  const [category, setCategory] = useState<Category | "all">("all");
  const marketShown = useMemo(
    () =>
      (market ?? []).filter((m) => {
        const q = query.trim().toLowerCase();
        if (category !== "all" && !categoriesOf(m).includes(category)) return false;
        return !q || matches([m.name, m.id, m.description, m.publisher, ...(m.authors ?? [])], q);
      }),
    [market, query, category],
  );
  const selectedMarket = marketShown.find((m) => m.id === selectedMarketId) ?? null;

  const shown = useMemo(() => filterPlugins(plugins, query), [plugins, query]);
  const downloaded = shown.filter((p) => p.source === "installed");
  const dev = shown.filter((p) => p.source === "dev");
  const linked = shown.filter((p) => p.source === "linked");
  const selected = shown.find((p) => p.id === selectedId) ?? shown[0] ?? null;

  // Local packages have no categories: shown only without a category filter.
  const catalogShown = useMemo(
    () => (category === "all" ? filterCatalog(catalog ?? [], query) : []),
    [catalog, query, category],
  );
  const selectedEntry = catalogShown.find((c) => c.id === selectedCatalogId) ?? catalogShown[0] ?? null;

  const showInstalled = (id: string | null) => {
    if (!id) return;
    setTab("installed");
    setSelectedId(id);
  };

  const openGear = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu(
      { x: r.left, y: r.bottom + 2 },
      gearMenu(plugins, (market ?? []).filter(isUpdate).length, {
        canImport: useProject.getState().project?.trusted === true,
        install: (packageFile) => void installFromDisk(undefined, packageFile).then(showInstalled),
        importIntellijFile: () => void importIntellijTheme().then(showInstalled),
        importInstalledIntellij: () => showInstalledIntellijThemes(showInstalled),
        editRepository: () => void editMarketUrl(),
      }),
    );
  };

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <Tabs
          variant="compact"
          className={styles.tabs}
          aria-label="Plugin sources"
          activeId={tab}
          onSelect={(id) => setTab(id as Tab)}
          items={[
            { id: "marketplace", label: "Available" },
            {
              id: "installed",
              label: "Installed",
              trailing: <span className={styles.tabCount}>{plugins.length}</span>,
            },
          ]}
        />
        <span title={tx("The plugin system is a preview: its API and the plugins may still change.")}>
          <Badge tone="accent">
            <T>Preview</T>
          </Badge>
        </span>
        <span className={styles.spacer} />
        {(loading || installing) && <Spinner size={14} label={installing ? "Installing plugin" : "Loading plugins"} />}
        <IconButton icon="settings" title="Manage Plugins" aria-haspopup="menu" onClick={openGear} />
      </div>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      <div className={styles.body}>
        <div className={styles.side}>
          <SearchField
            className={styles.search}
            value={query}
            onChange={setQuery}
            placeholder={tab === "installed" ? "Search installed plugins" : "Search plugins"}
            aria-label="Filter plugins"
          />
          {tab === "installed" ? (
            <ul className={styles.list} aria-label={tx("Installed plugins")}>
              {downloaded.length > 0 && <ListHeader title="Downloaded" count={downloaded.length} />}
              {downloaded.map((p) => (
                <InstalledRow
                  key={p.id}
                  plugin={p}
                  selected={p.id === selected?.id}
                  onSelect={() => setSelectedId(p.id)}
                />
              ))}
              {linked.length > 0 && <ListHeader title="Linked for development" count={linked.length} />}
              {linked.map((p) => (
                <InstalledRow
                  key={p.id}
                  plugin={p}
                  selected={p.id === selected?.id}
                  onSelect={() => setSelectedId(p.id)}
                />
              ))}
              {dev.length > 0 && <ListHeader title="Project (.openidea/plugins)" count={dev.length} />}
              {dev.map((p) => (
                <InstalledRow
                  key={p.id}
                  plugin={p}
                  selected={p.id === selected?.id}
                  onSelect={() => setSelectedId(p.id)}
                />
              ))}
              {loaded && shown.length === 0 && (
                <li className={styles.listEmpty}>
                  {plugins.length === 0 ? tx("No plugins installed.") : tx("No plugins match.")}
                </li>
              )}
            </ul>
          ) : (
            <ul className={styles.list} aria-label={tx("Available plugins")}>
              {(market?.length ?? 0) > 0 && (
                <li className={styles.marketItem}>
                  <CategoryFilter market={market ?? []} value={category} onChange={setCategory} />
                </li>
              )}
              {marketError && <li className={clsx(styles.listEmpty, styles.errorText)}>{marketError}</li>}
              {marketShown.length > 0 && <ListHeader title="Marketplace" count={marketShown.length} />}
              {marketShown.map((m) => (
                <MarketRow
                  key={`market:${m.id}`}
                  entry={m}
                  selected={m.id === selectedMarket?.id}
                  onSelect={() => setSelectedMarketId(m.id)}
                />
              ))}
              {catalogShown.length > 0 && <ListHeader title="Local" count={catalogShown.length} />}
              {catalogShown.map((c) => (
                <CatalogRow
                  key={c.id}
                  entry={c}
                  selected={c.id === selectedEntry?.id}
                  onSelect={() => {
                    setSelectedMarketId(null);
                    setSelectedCatalogId(c.id);
                  }}
                />
              ))}
              {catalog && category === "all" && catalogShown.length === 0 && (
                <li className={styles.listEmpty}>
                  {catalog.length === 0 ? tx("No local plugin packages.") : tx("No plugins match.")}
                </li>
              )}
              {catalogError && <li className={clsx(styles.listEmpty, styles.errorText)}>{catalogError}</li>}
            </ul>
          )}
        </div>

        {tab === "installed" ? (
          selected ? (
            <InstalledDetails key={selected.id} plugin={selected} />
          ) : (
            <EmptyState className={styles.detailsEmpty} title={loaded ? "No plugin selected" : "Loading…"}>
              <T>Plugins are folders with a</T> <code>plugin.toml</code>
              <T>. Use the gear menu to install one from disk, or put dev plugins in</T> <code>.openidea/plugins/</code>{" "}
              <T>inside your project.</T>
            </EmptyState>
          )
        ) : selectedMarket ? (
          <MarketDetails
            key={`market:${selectedMarket.id}`}
            entry={selectedMarket}
            onInstalled={(id) => {
              setTab("installed");
              setSelectedId(id);
            }}
          />
        ) : selectedEntry ? (
          <CatalogDetails key={selectedEntry.id} entry={selectedEntry} />
        ) : marketUrl ? (
          <EmptyState className={styles.detailsEmpty} title="No plugin selected" />
        ) : (
          <EmptyState className={styles.detailsEmpty} title={NO_REPOSITORY}>
            <T>Install a plugin folder with</T> <code>plugin.toml</code>{" "}
            <T>via the gear menu › Install Plugin from Disk….</T>
          </EmptyState>
        )}
      </div>
    </div>
  );
}
