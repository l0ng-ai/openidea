/**
 * "Execute Maven Goal" / "Execute Gradle Task" (IDEA's Run Anything popup for a
 * build tool): a command line with completion of lifecycle phases and plugin
 * goals (Maven) or task names / paths (Gradle), plus recent command lines.
 * Tab or a click accepts a completion; Enter runs the line in the chosen project.
 */
import { useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { BuildTool } from "@/platform/ipc";
import { HighlightedText, Input, List, Popup, Select, listNavigate, T } from "@/ui";
import { goalCompletions, gradleProjectForKey, gradleProjectKey, taskCompletions, type Completion } from "./model";
import { executeBuildLine } from "./runAnything";
import { readHistory, useBuild } from "./store";
import styles from "./BuildTools.module.css";

export function ExecutePopupHost() {
  const tool = useBuild((s) => s.executeOpen);
  if (!tool) return null;
  return <ExecutePopup key={tool} tool={tool} />;
}

function ExecutePopup({ tool }: { tool: BuildTool }) {
  const model = useBuild((s) => s.model);
  const current = useBuild((s) => s.current[tool]);
  const [line, setLine] = useState("");
  const [active, setActive] = useState(-1);
  const history = useMemo(() => readHistory(tool), [tool]);
  const maven = model?.maven;
  const gradle = model?.gradle;

  const projects = useMemo(
    () =>
      tool === "maven"
        ? (maven?.projects ?? []).map((p) => ({ value: p.pom, label: p.displayName, detail: p.dir || "." }))
        : (gradle ?? []).flatMap((build) =>
            build.projects.map((p) => ({
              value: gradleProjectKey(build, p),
              label: p.name,
              detail: `${build.dir || "."} ${p.path}`,
            })),
          ),
    [tool, maven, gradle],
  );
  const [project, setProject] = useState<string | null>(() =>
    projects.some((p) => p.value === current) ? current! : (projects[0]?.value ?? null),
  );

  const completions = useMemo<Completion[]>(() => {
    if (tool === "maven") {
      const p = maven?.projects.find((x) => x.pom === project);
      return goalCompletions(line, p?.plugins ?? [], history).slice(0, 200);
    }
    const selected = gradleProjectForKey(gradle ?? [], project);
    return selected ? taskCompletions(line, selected.build, history).slice(0, 200) : [];
  }, [tool, maven, gradle, project, line, history]);

  const close = () => useBuild.setState({ executeOpen: null });

  const execute = () => {
    const text = line.trim();
    if (text && executeBuildLine(tool, text, project)) close();
  };

  const accept = (c: Completion | undefined) => {
    if (!c) return;
    setLine(c.detail === "recent" ? c.line : `${c.line} `);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "PageDown" || e.key === "PageUp") {
      const next = listNavigate(e.key, { items: completions, active: Math.max(active, 0), wrap: true });
      if (next !== null) {
        e.preventDefault();
        setActive(active < 0 && e.key === "ArrowDown" ? 0 : next);
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      accept(completions[Math.max(active, 0)]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) accept(completions[active]);
      else execute();
    }
  };

  const title = tool === "maven" ? "Execute Maven Goal" : "Execute Gradle Task";
  const word = /\S*$/.exec(line)![0];
  return (
    <Popup
      open
      anchor={{ x: window.innerWidth / 2, y: 72 }}
      placement="bottom"
      onClose={close}
      role="dialog"
      aria-label={title}
      className={styles.popup}
      trapFocus
    >
      <div className={styles.popupBody}>
        <div className={styles.popupHeader}>
          <span className={styles.popupTitle}>{title}</span>
          <span>
            <T>Tab to complete, Enter to run</T>
          </span>
        </div>
        <div className={styles.inputRow}>
          <span className={styles.inputPrefix}>{tool === "maven" ? "mvn" : "gradle"}</span>
          <Input
            data-autofocus
            variant="bare"
            className={styles.input}
            value={line}
            placeholder={tool === "maven" ? "clean install -DskipTests" : "build --info"}
            aria-label={tool === "maven" ? "Maven command line" : "Gradle command line"}
            onChange={(e) => {
              setLine(e.target.value);
              setActive(-1);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <List
          items={completions}
          getKey={(c) => `${c.detail === "recent" ? "h" : "c"}:${c.line}`}
          activeIndex={active}
          onActiveChange={setActive}
          onActivate={(c) => accept(c)}
          focusable={false}
          hoverSelects={false}
          rowHeight={22}
          className={styles.completions}
          aria-label="Completions"
          empty={<div className={styles.empty}>{line.trim() ? "No completions" : "Type a goal"}</div>}
          renderItem={(c, state) => (
            <div className={clsx(styles.completion, state.active && styles.activeRow)}>
              <span className={styles.completionLabel}>
                <HighlightedText
                  text={c.label}
                  indices={c.detail === "recent" ? undefined : [...Array(Math.min(word.length, c.label.length)).keys()]}
                />
              </span>
              {c.detail && <span className={styles.completionDetail}>{c.detail}</span>}
            </div>
          )}
        />
        <div className={styles.popupFooter}>
          <span>
            <T>Project:</T>
          </span>
          <Select
            className={styles.footerSelect}
            value={project}
            options={projects}
            onChange={setProject}
            aria-label="Project to run in"
          />
        </div>
      </div>
    </Popup>
  );
}
