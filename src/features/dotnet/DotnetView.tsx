import { executeAction } from "@/platform/actions";
import { useState } from "react";
import { useProject } from "@/platform/project";
import { useTx } from "@/platform/i18n";
import { Button, Input } from "@/ui";
import { useDotnet } from "./store";
import styles from "./Dotnet.module.css";

export function DotnetView() {
  const s = useDotnet();
  const tx = useTx();
  const root = useProject((state) => state.project?.root ?? "");
  const relative = (path: string) => (root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path);
  const [versions, setVersions] = useState<Record<string, string>>({});
  const results = new Map<string, string[]>();
  for (const p of s.found) results.set(p.id, [...new Set([...(results.get(p.id) ?? []), p.version])]);
  const project = s.model.projects.find((p) => p.path === s.selected);
  const action = (id: string, arg?: unknown) => void executeAction(`dotnet.${id}`, arg);
  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        <Button disabled={s.busy} onClick={() => action("reload")}>
          {tx("Reload .NET Workspace")}
        </Button>
        {s.busy && <Button onClick={() => action("cancel")}>{tx("Cancel")}</Button>}
      </div>
      {s.error && (
        <div role="alert" className={styles.error}>
          {s.error}
        </div>
      )}
      {s.model.errors?.map((error) => (
        <details key={error} className={styles.error}>
          <summary>{tx("Project evaluation failed")}</summary>
          {error}
        </details>
      ))}
      {s.model.solutions.map((solution) => (
        <details key={solution.path}>
          <summary>{solution.path.split("/").at(-1)}</summary>
          {solution.projects.map((path) => (
            <Button key={path} title={path} disabled={s.busy} onClick={() => action("select", { path })}>
              {relative(path)}
            </Button>
          ))}
        </details>
      ))}
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
              {relative(p.path)}
            </option>
          ))}
        </select>
      </label>
      {project && (
        <>
          <div className={styles.toolbar}>
            <label>
              {tx("Configuration")}
              <select
                aria-label={tx("Configuration")}
                disabled={s.busy}
                value={s.configuration}
                onChange={(e) =>
                  action("select", { path: s.selected, configuration: e.target.value, framework: s.framework })
                }
              >
                {project.configurations.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              {tx("Target framework")}
              <select
                aria-label={tx("Target framework")}
                disabled={s.busy}
                value={s.framework}
                onChange={(e) =>
                  action("select", { path: s.selected, configuration: s.configuration, framework: e.target.value })
                }
              >
                {project.frameworks.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
          </div>
          <div className={styles.toolbar}>
            {["build", "restore", "clean"].map((op) => (
              <Button key={op} disabled={s.busy} onClick={() => action(op)}>
                {tx(op === "build" ? "Build" : op === "restore" ? "Restore" : "Clean")}
              </Button>
            ))}
          </div>
          <details open>
            <summary>{tx("Project references")}</summary>
            {project.references.map((path) => (
              <Button
                key={path}
                disabled={s.busy || !s.model.projects.some((p) => p.path === path)}
                onClick={() => action("select", { path })}
              >
                {relative(path)}
              </Button>
            ))}
          </details>
          <details open>
            <summary>{tx("NuGet packages")}</summary>
            <Button disabled={s.busy} onClick={() => action("packages")}>
              {tx("Refresh packages")}
            </Button>
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
          </details>
          {project.test && (
            <details open>
              <summary>{tx("Tests")}</summary>
              <div className={styles.toolbar}>
                <Button disabled={s.busy} onClick={() => action("discover")}>
                  {tx("Discover .NET Tests")}
                </Button>
                <Button disabled={s.busy} onClick={() => action("test")}>
                  {tx("Run all tests")}
                </Button>
              </div>
              {project.runner !== "vstest" && !project.trx && (
                <div>
                  {tx("Install the TRX reporting extension to show MTP results in the test panel.")}
                  <Button disabled={s.busy} onClick={() => action("installTrx")}>
                    {tx("Install TRX reporting")}
                  </Button>
                </div>
              )}
              <ul className={styles.list}>
                {s.tests.map((test) => (
                  <li key={test}>
                    <span>{test}</span>
                    <Button disabled={s.busy} onClick={() => action("test", test)}>
                      {tx("Run test")}
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}
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
