/**
 * NuGet tool window: the selected .NET project's packages, with search and
 * install / update / remove. The package management that used to live in the
 * standalone .NET tool window (#5635).
 */
import { useEffect, useState } from "react";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { Button, Input } from "@/ui";
import { ensureDotnetModel, useDotnet } from "./store";
import styles from "./Nuget.module.css";

export function NugetView() {
  const s = useDotnet();
  const tx = useTx();
  const [versions, setVersions] = useState<Record<string, string>>({});
  const results = new Map<string, string[]>();
  for (const p of s.found) results.set(p.id, [...new Set([...(results.get(p.id) ?? []), p.version])]);
  const project = s.model.projects.find((p) => p.path === s.selected);
  const action = (id: string, arg?: unknown) => void executeAction(`dotnet.${id}`, arg);
  // The workspace scan used to run when the standalone .NET window opened; without it the
  // window shows no project to manage packages for.
  useEffect(() => {
    void ensureDotnetModel();
  }, []);
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <Button disabled={s.busy} onClick={() => action("packages")}>
          {tx("Refresh packages")}
        </Button>
        {s.busy && <Button onClick={() => action("cancel")}>{tx("Cancel")}</Button>}
      </div>
      {s.error && (
        <div role="alert" className={styles.error}>
          {s.error}
        </div>
      )}
      <label>
        {tx(".NET project")}
        <select
          aria-label={tx(".NET project")}
          value={s.selected}
          disabled={s.busy}
          onChange={(e) => action("select", { path: e.target.value })}
        >
          {!project && <option value="">{tx("Select a .NET project")}</option>}
          {s.model.projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {project && (
        <>
          <form
            className={styles.toolbar}
            onSubmit={(e) => {
              e.preventDefault();
              action("search", { query: s.query });
            }}
          >
            <Input
              aria-label={tx("Search NuGet packages")}
              value={s.query}
              onChange={(e) => useDotnet.setState({ query: e.target.value })}
            />
            <Button type="submit" disabled={s.busy || !s.query.trim()}>
              {tx("Search")}
            </Button>
          </form>
          <ul className={styles.list}>
            {[...results].map(([id, available]) => {
              const version = available.includes(versions[id] ?? "") ? versions[id]! : available[0]!;
              return (
                <li key={id}>
                  <span>{id}</span>
                  <select
                    aria-label={tx("Version")}
                    value={version}
                    disabled={s.busy}
                    onChange={(e) => setVersions({ ...versions, [id]: e.target.value })}
                  >
                    {available.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                  <Button disabled={s.busy} onClick={() => action("packageChange", { id, version })}>
                    {tx("Install / Update")}
                  </Button>
                  <Button disabled={s.busy} onClick={() => action("search", { query: id, exact: true })}>
                    {tx("Versions")}
                  </Button>
                </li>
              );
            })}
          </ul>
          <ul className={styles.list}>
            {s.packages.map((p) => (
              <li key={`${p.id}:${p.version}`}>
                <span>
                  {p.id} {p.version} {p.transitive ? tx("Transitive") : ""}
                </span>
                {!p.transitive && (
                  <>
                    <Button disabled={s.busy} onClick={() => action("search", { query: p.id, exact: true })}>
                      {tx("Versions")}
                    </Button>
                    <Button disabled={s.busy} onClick={() => action("packageChange", { id: p.id, version: null })}>
                      {tx("Remove")}
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {s.output && (
        <details>
          <summary>{tx("Output")}</summary>
          <pre className={styles.output}>{s.output}</pre>
        </details>
      )}
    </div>
  );
}
