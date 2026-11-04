import { useEffect, useRef } from "react";
import { create } from "zustand";
import { executeAction, registerActions } from "@/platform/actions";
import { getContext, useContextKeys } from "@/platform/context";
import { call, commands, onIdeEvent, type PhpLanguageLevel, type PhpLanguageLevels } from "@/platform/ipc";
import { PHP_LANGUAGE_LEVELS } from "@/platform/languageSettings";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { notifications, registerStatusItem } from "@/workbench/contributions";
import { BarButton, Menu, type MenuItem } from "@/ui";
import { phpLanguageLevel } from "./api";

/** What the widget last resolved for a project, so the popup action can read it without a render. */
interface Status extends PhpLanguageLevels {
  root: string;
}

const usePopup = create<{ open: boolean; status: Status | null }>(() => ({ open: false, status: null }));
const close = () => usePopup.setState({ open: false });
const reset = () => usePopup.setState({ open: false, status: null });

/** Whether the widget is on screen, read straight from the stores (the action runs outside a render). */
function popupShown(): boolean {
  const root = useProject.getState().project?.root;
  const status = usePopup.getState().status;
  return !!root && status?.root === root && getContext().editorLangId === "php";
}

/** `8.1.0` as `8.1`, the way the levels are listed. */
const shortVersion = (level: PhpLanguageLevel) => level.version.split(".").slice(0, 2).join(".");

const isComposerJson = (path: string) => path.replaceAll("\\", "/").split("/").at(-1) === "composer.json";

function origin(level: PhpLanguageLevel | null): string {
  if (!level) return tx("No PHP version in the settings or composer.json: Intelephense uses its default");
  const version = level.version;
  switch (level.source) {
    case "settings":
      return tx`PHP ${version}, set in the settings`;
    case "platform":
      return tx`PHP ${version}, from config.platform.php in composer.json`;
    case "require":
      return tx`PHP ${version}, the lowest version require.php in composer.json allows`;
  }
}

function PhpStatus() {
  const root = useProject((s) => s.project?.root);
  // Re-read on every settings change: Auto writes the same empty value the default has.
  const settings = useProject((s) => s.settings);
  const path = useContextKeys((s) =>
    s.editorLangId === "php" && typeof s.editorPath === "string" ? s.editorPath : null,
  );
  const status = usePopup((s) => s.status);
  const open = usePopup((s) => s.open);
  const anchor = useRef<HTMLButtonElement>(null);
  useEffect(() => reset, [root]);
  useEffect(() => {
    if (!path) close();
  }, [path]);
  useEffect(() => {
    if (!root || !path) return;
    let live = true;
    let sequence = 0;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const level = await phpLanguageLevel(path);
        if (live && sequence === request) usePopup.setState({ status: level && { root, ...level } });
      } catch (e) {
        console.warn("Cannot read the PHP language level", e);
      }
    };
    void refresh();
    const off = onIdeEvent("fsChanged", (e) => {
      if ([...e.created, ...e.modified, ...e.removed].some(isComposerJson)) void refresh();
    });
    return () => {
      live = false;
      off();
    };
  }, [root, path, settings]);
  // The widget only renders once its project's level is in the store, so the popup action
  // sees the same state as the button without waiting for an effect to publish a flag.
  if (!path || !popupShown() || !status) return null;
  const { effective, auto } = status;
  const label = effective ? `PHP ${shortVersion(effective)}` : "PHP";
  const chosen = effective?.source === "settings" ? shortVersion(effective) : "";
  const items: MenuItem[] = [
    { kind: "header", label: "PHP Language Level" },
    ...PHP_LANGUAGE_LEVELS.map((level): MenuItem =>
      level
        ? {
            label: level,
            verbatim: true,
            checked: level === chosen,
            run: () => void executeAction("php.selectLanguageLevel", level),
          }
        : {
            label: "Auto",
            shortcut: auto ? shortVersion(auto) : undefined,
            checked: !chosen,
            run: () => void executeAction("php.selectLanguageLevel", ""),
          },
    ),
  ];
  return (
    <>
      <BarButton
        ref={anchor}
        tooltip={origin(effective)}
        aria-label={tx`PHP Language Level: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => void executeAction("php.languageLevelPopup")}
      >
        {label}
      </BarButton>
      <Menu
        open={open}
        onClose={close}
        anchor={anchor}
        placement="top-end"
        items={items}
        aria-label="PHP Language Level"
      />
    </>
  );
}

export function activatePhpStatus(): () => void {
  const dispose = [
    registerStatusItem({
      id: "php.languageLevel",
      title: "PHP Language Level",
      align: "right",
      priority: 89,
      component: PhpStatus,
    }),
    registerActions([
      {
        id: "php.languageLevelPopup",
        title: "PHP Language Level",
        category: "Settings",
        keywords: ["php version"],
        when: "projectOpen",
        run: () =>
          popupShown()
            ? usePopup.setState((s) => ({ open: !s.open }))
            : void executeAction("file.settings", "languages.php"),
      },
      {
        id: "php.selectLanguageLevel",
        title: "Select PHP Language Level",
        category: "Settings",
        hidden: true,
        run: async ({ arg }) => {
          const project = useProject.getState().project;
          if (!project || typeof arg !== "string" || !PHP_LANGUAGE_LEVELS.some((level) => level === arg)) return;
          try {
            const settings = await call(
              commands.settingsSet("project", "languages.php.languageLevel", JSON.stringify(arg)),
            );
            if (useProject.getState().project === project) useProject.setState({ settings });
          } catch (e) {
            notifications().notify({ level: "error", title: "Cannot select PHP language level", body: String(e) });
          }
        },
      },
    ]),
  ];
  return () => {
    reset();
    dispose.reverse().forEach((d) => d());
  };
}
