import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { BarButton, Icon, IconButton, Popup, T } from "@/ui";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { backgroundProjectState, unloadBackgroundProject, useBackgroundProjects } from "@/platform/mcpBackground";
import { basename } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { ProjectBadge } from "@/workbench/ProjectBadge";
import styles from "./BackgroundStatus.module.css";

/** Status bar item for the projects the MCP server holds open without a window. */
export function BackgroundStatus() {
  const t = useTx();
  const loaded = useBackgroundProjects();
  // A remote window's commands reach its server, which serves none: the desktop's list stays out of it.
  const remote = useRemote((s) => s.session !== null);
  const projects = remote ? [] : loaded;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const count = projects.length;

  // Reset during render, so the popup does not reappear with the next project that loads.
  if (count === 0 && open) setOpen(false);

  if (count === 0) return null;
  return (
    <>
      <BarButton
        ref={ref}
        aria-expanded={open}
        aria-label={t`Background Projects: ${count}`}
        tooltip={t("Projects the MCP server holds open without a window")}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="layers" size={14} />
        {count}
      </BarButton>
      <Popup
        open={open}
        anchor={ref}
        placement="top-end"
        offset={6}
        onClose={() => setOpen(false)}
        aria-label={t("Background Projects")}
      >
        {/* The focus starts on the list: on a row it would swap that row's state for its actions. */}
        <div className={styles.panel} tabIndex={-1} data-autofocus>
          <div className={styles.header}>
            <T>Served without a window</T>
          </div>
          <ul className={styles.projects}>
            {projects.map((project) => {
              const path = project.root;
              const name = basename(path) || path;
              return (
                <li key={path} className={styles.project}>
                  <ProjectBadge name={name} path={path} />
                  <div className={styles.text}>
                    <span className={styles.top}>
                      <span className={styles.name} title={name}>
                        {name}
                      </span>
                      <span className={styles.state}>{backgroundProjectState(project)}</span>
                    </span>
                    <span className={styles.path} title={path}>
                      {path}
                    </span>
                  </div>
                  <span className={styles.actions}>
                    <IconButton
                      icon="external-link"
                      size="small"
                      title="Open in New Window"
                      aria-label={t`Open ${path} in a new window`}
                      onClick={() => void executeAction("file.openInNewWindow", path)}
                    />
                    <IconButton
                      icon="close"
                      size="small"
                      title="Unload"
                      aria-label={t`Unload ${path}`}
                      onClick={() => unloadBackgroundProject(path)}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
          <div className={styles.separator} role="separator" />
          <button
            type="button"
            className={styles.action}
            onClick={() => projects.forEach((p) => unloadBackgroundProject(p.root))}
          >
            <T>Unload All</T>
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              flushSync(() => setOpen(false));
              void executeAction("file.settings", "agents.mcpServer");
            }}
          >
            <T>MCP Server Settings…</T>
          </button>
        </div>
      </Popup>
    </>
  );
}
