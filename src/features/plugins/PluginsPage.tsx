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
import type { CatalogPlugin, Permission, PluginInfo, PluginStatus } from "@/bindings";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Icon,
  IconButton,
  Kbd,
  SearchField,
  Spinner,
  Tabs,
  showContextMenu,
  type MenuItem,
  T,
} from "@/ui";
import { pluginActionId } from "./bridge";
import {
  compareVersions,
  installFromDisk,
  refreshCatalog,
  refreshPlugins,
  reloadPlugin,
  runPluginCommand,
  selectPluginTheme,
  setAllInstalledEnabled,
  setPluginEnabled,
  uninstallPlugin,
  usePlugins,
} from "./store";
import styles from "./PluginsPage.module.css";
import { tx } from "@/platform/i18n";

const STATUS: Record<PluginStatus, { label: string; tone: "success" | "accent" | "neutral" | "danger" }> = {
  active: { label: "Running", tone: "success" },
  static: { label: "Enabled", tone: "accent" },
  disabled: { label: "Disabled", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

export const PERMISSION_TEXT: Record<Permission, string> = {
  "project-read": "Read files inside the open project",
  "editor-read": "See which file is open in the editor",
  "editor-write": "Insert text into the active editor",
};

export const NO_REPOSITORY = "There is no online plugin repository";

type Tab = "marketplace" | "installed";

const matches = (texts: readonly (string | null | undefined)[], q: string) =>
  texts.some((s) => !!s && s.toLowerCase().includes(q));

export function filterPlugins(plugins: readonly PluginInfo[], query: string): PluginInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...plugins];
  return plugins.filter((p) =>
    matches([p.name, p.id, p.description, ...p.authors, ...p.commands.map((c) => c.title)], q),
  );
}

export function filterCatalog(catalog: readonly CatalogPlugin[], query: string): CatalogPlugin[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...catalog];
  return catalog.filter((p) =>
    matches([p.name, p.id, p.description, ...p.authors, ...p.commands.map((c) => c.title)], q),
  );
}

/** What the Available tab offers for a catalog package given what is installed. */
export function catalogState(
  entry: CatalogPlugin,
  installed: readonly PluginInfo[],
): "install" | "update" | "installed" | "dev" {
  const have = installed.find((p) => p.id === entry.id);
  if (!have) return "install";
  if (have.source === "dev") return "dev";
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
            {plugin.source === "dev" && (
              <span className={styles.devTag}>
                <T>dev</T>
              </span>
            )}
            {plugin.status === "failed" && (
              <Badge dot tone="danger">
                <T>Failed</T>
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

function InstalledDetails({ plugin }: { plugin: PluginInfo }) {
  const busy = usePlugins((s) => !!s.busy[plugin.id]);
  const activeTheme = usePlugins((s) => s.activeTheme);
  const status = STATUS[plugin.status];
  const running = plugin.status === "active";
  const live = running || plugin.status === "static";
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

      {plugin.hasCode && (
        <Section title="Permissions">
          {plugin.permissions.length === 0 ? (
            <div className={styles.muted}>
              <T>No special permissions.</T>
            </div>
          ) : (
            <ul className={styles.items}>
              {plugin.permissions.map((p) => (
                <li key={p} className={styles.item}>
                  <span className={styles.itemMain}>{PERMISSION_TEXT[p] ?? p}</span>
                  <span className={styles.mono}>{p}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {plugin.commands.length > 0 && (
        <Section title="Commands">
          <ul className={styles.items}>
            {plugin.commands.map((c) => {
              const actionId = pluginActionId(plugin.id, c.id);
              return (
                <li key={c.id} className={styles.item}>
                  <span className={styles.itemMain}>{c.title}</span>
                  <Kbd action={actionId} />
                  <span className={styles.mono} title={tx("Action id (bind it in Keymap)")}>
                    {actionId}
                  </span>
                  <Button
                    size="small"
                    variant="ghost"
                    icon="run"
                    disabled={!running}
                    onClick={() => void runPluginCommand(plugin.id, c.id)}
                    aria-label={tx`Run ${c.title}`}
                  >
                    <T>Run</T>
                  </Button>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {plugin.themes.length > 0 && (
        <Section title="Themes">
          <ul className={styles.items}>
            {plugin.themes.map((t) => {
              const isActive = activeTheme?.pluginId === plugin.id && activeTheme.theme.id === t.id;
              return (
                <li key={t.id} className={styles.item}>
                  <span className={styles.itemMain}>{t.name}</span>
                  <span className={styles.muted}>{t.kind === "dark" ? tx("Dark") : tx("Light")}</span>
                  {isActive ? (
                    <Button size="small" variant="secondary" onClick={() => void selectPluginTheme(null, null)}>
                      <T>Use Default Theme</T>
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!live}
                      onClick={() => void selectPluginTheme(plugin.id, t.id)}
                      aria-label={tx`Apply theme ${t.name}`}
                    >
                      <T>Apply</T>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {plugin.languages.length > 0 && (
        <Section title="Languages">
          <ul className={styles.items}>
            {plugin.languages.map((l) => (
              <li key={l.id} className={styles.item}>
                <span className={styles.itemMain}>{l.name}</span>
                <span className={styles.mono}>{l.extensions.map((e) => `.${e}`).join(" ") || l.id}</span>
              </li>
            ))}
          </ul>
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
            {plugin.source === "dev" && (
              <Badge tone="warning">
                <T>Dev plugin</T>
              </Badge>
            )}
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
  const contributes = [
    entry.commands.length && `${entry.commands.length} ${entry.commands.length === 1 ? "command" : "commands"}`,
    entry.themeCount && `${entry.themeCount} ${entry.themeCount === 1 ? "theme" : "themes"}`,
    entry.languageCount && `${entry.languageCount} ${entry.languageCount === 1 ? "language" : "languages"}`,
  ].filter(Boolean);
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
      {entry.permissions.length > 0 && (
        <Section title="Permissions">
          <ul className={styles.items}>
            {entry.permissions.map((p) => (
              <li key={p} className={styles.item}>
                <span className={styles.itemMain}>{PERMISSION_TEXT[p] ?? p}</span>
                <span className={styles.mono}>{p}</span>
              </li>
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

function gearMenu(plugins: readonly PluginInfo[], install: () => void): MenuItem[] {
  const installed = plugins.filter((p) => p.source === "installed");
  return [
    { label: "Install Plugin from Disk…", icon: "package", run: install },
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
      },
    },
  ];
}

export function PluginsPage() {
  const { plugins, loaded, loading, error, installing, catalog, catalogError } = usePlugins();
  const [tab, setTab] = useState<Tab>("installed");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>(null);

  useEffect(() => {
    void refreshPlugins();
    void refreshCatalog();
  }, []);

  const shown = useMemo(() => filterPlugins(plugins, query), [plugins, query]);
  const downloaded = shown.filter((p) => p.source === "installed");
  const dev = shown.filter((p) => p.source === "dev");
  const selected = shown.find((p) => p.id === selectedId) ?? shown[0] ?? null;

  const catalogShown = useMemo(() => filterCatalog(catalog ?? [], query), [catalog, query]);
  const selectedEntry = catalogShown.find((c) => c.id === selectedCatalogId) ?? catalogShown[0] ?? null;

  const install = async () => {
    const id = await installFromDisk();
    if (id) {
      setTab("installed");
      setSelectedId(id);
    }
  };

  const openGear = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu(
      { x: r.left, y: r.bottom + 2 },
      gearMenu(plugins, () => void install()),
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
            placeholder={tab === "installed" ? "Search installed plugins" : "Search local plugins"}
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
              <li className={styles.notice} role="note">
                <Icon name="info" size={14} />
                <span>{tx`${NO_REPOSITORY}. Showing plugin packages available on this machine.`}</span>
              </li>
              {catalogShown.length > 0 && <ListHeader title="Local" count={catalogShown.length} />}
              {catalogShown.map((c) => (
                <CatalogRow
                  key={c.id}
                  entry={c}
                  selected={c.id === selectedEntry?.id}
                  onSelect={() => setSelectedCatalogId(c.id)}
                />
              ))}
              {catalog && catalogShown.length === 0 && (
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
        ) : selectedEntry ? (
          <CatalogDetails key={selectedEntry.id} entry={selectedEntry} />
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
