/**
 * Languages & Frameworks › SQL Resolution Scopes: which data source (and schema) SQL in a
 * folder or file resolves against — completion, inspections, navigation and running
 * consoles there. The project row applies wherever no folder or file row does.
 */
import { useEffect, useState } from "react";
import { call, commands, type DataSource } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { IconButton, Input, Select, T, type SelectOption } from "@/ui";
import { useSettingsForm } from "@/workbench/contributions";
import { scopePath, validateResolutionScopes, type SqlResolutionScope } from "./resolutionScopes";
import styles from "./SqlScopesPage.module.css";

const KEY = "database.resolutionScopes";
const NONE = "";
/** An example path, the same in every language. */
const PATH_EXAMPLE = "src/main/resources/mapper";

function useDataSources(): DataSource[] | null {
  const [sources, setSources] = useState<DataSource[] | null>(null);
  useEffect(() => {
    let stale = false;
    call(commands.dbSources())
      .then((list) => !stale && setSources(list))
      .catch(() => !stale && setSources([]));
    return () => {
      stale = true;
    };
  }, []);
  return sources;
}

export function SqlScopesPage() {
  const form = useSettingsForm();
  const scopes = validateResolutionScopes(form.useValue(KEY));
  const sources = useDataSources();
  const set = (next: SqlResolutionScope[]) => form.set(KEY, next);

  const options: SelectOption[] = [
    { value: NONE, label: tx("<none>") },
    ...(sources ?? []).map((s) => ({ value: s.id ?? "", label: s.name ?? s.id ?? "", icon: "database" })),
  ];
  const sourceOptions = (current: string) =>
    current && !options.some((o) => o.value === current)
      ? [...options, { value: current, label: tx`${current} (missing)` }]
      : options;

  const projectIndex = scopes.findIndex((s) => !s.path);
  const project = scopes[projectIndex];
  const rows = scopes.map((scope, index) => ({ scope, index })).filter(({ index }) => index !== projectIndex);
  const empty = (): SqlResolutionScope => ({ path: "", dataSource: NONE, schema: "" });

  const patch = (index: number, p: Partial<SqlResolutionScope>) =>
    set(scopes.map((s, i) => (i === index ? { ...s, ...p } : s)));
  const setProject = (p: Partial<SqlResolutionScope>) =>
    project ? patch(projectIndex, p) : set([{ ...empty(), ...p }, ...scopes]);

  return (
    <div className={styles.page}>
      <p className={styles.intro}>
        <T>
          SQL in these folders and files resolves against the data source: completion, inspections and navigation use
          its tables, and query consoles run on it unless another data source is picked in their toolbar.
        </T>
      </p>
      <div className={styles.list} role="table" aria-label={tx("SQL Resolution Scopes")}>
        <div className={styles.head} role="row">
          <span role="columnheader">
            <T>Path</T>
          </span>
          <span role="columnheader">
            <T>Data Source</T>
          </span>
          <span role="columnheader">
            <T>Schema</T>
          </span>
          <span />
        </div>
        <div className={styles.row} role="row">
          <span className={styles.project} role="cell">
            <T>Project</T>
          </span>
          <Select
            value={project?.dataSource ?? NONE}
            options={sourceOptions(project?.dataSource ?? NONE)}
            onChange={(dataSource) => setProject({ dataSource })}
            aria-label={tx("Project data source")}
          />
          <Input
            mono
            value={project?.schema ?? ""}
            placeholder={tx("Default")}
            onChange={(e) => setProject({ schema: e.target.value })}
            aria-label={tx("Project schema")}
          />
          <span />
        </div>
        {rows.map(({ scope, index }) => (
          <div key={index} className={styles.row} role="row">
            <Input
              mono
              value={scope.path}
              placeholder={PATH_EXAMPLE}
              invalid={!scopePath(scope.path)}
              onChange={(e) => patch(index, { path: e.target.value })}
              aria-label={tx("Path")}
            />
            <Select
              value={scope.dataSource}
              options={sourceOptions(scope.dataSource)}
              onChange={(dataSource) => patch(index, { dataSource })}
              aria-label={tx("Data source")}
            />
            <Input
              mono
              value={scope.schema}
              placeholder={tx("Default")}
              onChange={(e) => patch(index, { schema: e.target.value })}
              aria-label={tx("Schema")}
            />
            <IconButton
              icon="trash"
              size="small"
              title="Remove"
              onClick={() => set(scopes.filter((_, i) => i !== index))}
            />
          </div>
        ))}
      </div>
      <div>
        <IconButton
          icon="plus"
          size="small"
          title="Add Folder or File"
          // The first row without a path is the project's: keep one ahead of the new row.
          onClick={() => set([...(project ? [] : [empty()]), ...scopes, empty()])}
        />
      </div>
      <p className={styles.hint}>
        <T>Paths are relative to the project root. The deepest folder or file that contains a file applies to it.</T>
      </p>
    </div>
  );
}
