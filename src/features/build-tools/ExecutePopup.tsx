/**
 * "Execute Maven Goal" / "Execute Gradle Task" (IDEA's Run Anything popup for a
 * build tool): a command line with completion of lifecycle phases and plugin
 * goals (Maven) or task names / paths (Gradle), plus recent command lines.
 * Tab completes the word. Selecting a row (click or arrows) shows its command line in the input;
 * Enter or a double-click runs it (or the typed line) in the chosen project.
 */
import { useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { BuildTool } from "@/platform/ipc";
import { HighlightedText, Icon, Input, List, Popup, Select, listNavigate, T } from "@/ui";
import { goalCompletions, gradleProjectForKey, gradleProjectKey, taskCompletions, type Completion } from "./model";
import { executeBuildLine } from "./runAnything";
import { readHistory, useBuild } from "./store";
import styles from "./BuildTools.module.css";

type CompletionRow =
  | { kind: "section"; key: string; label: string }
  | { kind: "completion"; key: string; completion: Completion };

const isSection = (row: CompletionRow) => row.kind === "section";

export function ExecutePopupHost() {
  const tool = useBuild((s) => s.executeOpen);
  if (!tool) return null;
  return <ExecutePopup key={tool} tool={tool} />;
}

function ExecutePopup({ tool }: { tool: BuildTool }) {
  const model = useBuild((s) => s.model);
  const current = useBuild((s) => s.current[tool]);
  const [line, setLine] = useState("");
  const [selection, setSelection] = useState<{ rows: CompletionRow[]; index: number } | null>(null);
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

  const command = tool === "maven" ? "mvn" : "gradle";
  const commandIcon = tool === "maven" ? "file-maven" : "file-gradle";
  const rows = useMemo<CompletionRow[]>(() => {
    const sections = [
      { key: "recent", label: "Recent", items: completions.filter((item) => item.detail === "recent") },
      {
        key: "commands",
        label: tool === "maven" ? "Maven Goals" : "Gradle Tasks",
        items: completions.filter((item) => item.detail !== "recent"),
      },
    ];
    return sections.flatMap<CompletionRow>((section) => {
      if (!section.items.length) return [];
      return [
        { kind: "section", key: section.key, label: section.label },
        ...section.items.map((completion): CompletionRow => ({
          kind: "completion",
          key: `${section.key}:${completion.line}`,
          completion,
        })),
      ];
    });
  }, [completions, tool]);
  const firstCompletion = rows.findIndex((row) => !isSection(row));
  const active = selection?.rows === rows ? selection.index : -1;
  const setActive = (index: number) => setSelection({ rows, index });

  const close = () => useBuild.setState({ executeOpen: null });

  const selectedRow = active >= 0 ? rows[active] : undefined;
  const selected = selectedRow?.kind === "completion" ? selectedRow.completion : null;

  const execute = (command = selected?.line ?? line) => {
    const text = command.trim();
    if (text && executeBuildLine(tool, text, project)) close();
  };

  const accept = (row: CompletionRow | undefined) => {
    if (row?.kind !== "completion") return;
    const completion = row.completion;
    setLine(completion.detail === "recent" ? completion.line : `${completion.line} `);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "PageDown" || e.key === "PageUp") {
      const next = listNavigate(e.key, { items: rows, active, wrap: true, isSection });
      if (next !== null) {
        e.preventDefault();
        setActive(next < 0 ? firstCompletion : next);
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      accept(rows[active < 0 ? firstCompletion : active]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      execute();
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
          <Icon name={commandIcon} size={16} className={styles.commandIcon} />
          <span className={styles.inputPrefix}>{command}</span>
          <Input
            data-autofocus
            variant="bare"
            className={styles.input}
            value={selected?.line ?? line}
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
          items={rows}
          getKey={(row) => row.key}
          isSection={isSection}
          renderSection={(row) => (
            <div className={styles.completionSection}>{row.kind === "section" && <T>{row.label}</T>}</div>
          )}
          activeIndex={active}
          onActiveChange={setActive}
          onActivate={(row, index, e) => {
            if (row.kind !== "completion") return;
            setActive(index);
            if (e.detail >= 2) execute(row.completion.line);
          }}
          focusable={false}
          hoverSelects={false}
          rowHeight={24}
          sectionHeight={28}
          className={styles.completions}
          aria-label="Completions"
          empty={<div className={styles.empty}>{line.trim() ? "No completions" : "Type a goal"}</div>}
          renderItem={(row, state) => {
            if (row.kind !== "completion") return null;
            const completion = row.completion;
            const recent = completion.detail === "recent";
            const matchStart = completion.line.length - completion.label.length;
            const indices = recent
              ? undefined
              : Array.from(
                  { length: Math.min(word.length, completion.label.length) },
                  (_, index) => matchStart + index,
                );
            const detail = recent || completion.detail === "phase" ? undefined : completion.detail;
            return (
              <div className={clsx(styles.completion, state.active && styles.activeRow)}>
                <Icon name={commandIcon} size={16} className={styles.commandIcon} />
                <span className={styles.completionLabel}>
                  {command} <HighlightedText text={completion.line} indices={indices} />
                </span>
                {detail && <span className={styles.completionDetail}>{detail}</span>}
              </div>
            );
          }}
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
