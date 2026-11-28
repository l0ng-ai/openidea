/**
 * Settings Sync: the Git repository the IDE settings sync through (a secret Gist's clone URL
 * works too) and what syncs. Sync Now runs `file.syncSettings` in the project window.
 */
import clsx from "clsx";
import { executeAction, useActions } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { Button } from "@/ui";
import { SearchLabel } from "../components/Form";
import { useAppliedSetting, useLabelMatch, useSetting } from "../components/context";
import formStyles from "../components/Form.module.css";
import styles from "./SettingsSync.module.css";
import type { PageSpec } from "./spec";

function SyncNowRow() {
  const tx = useTx();
  const canSync = useActions((s) => s.actions.has("file.syncSettings"));
  const matched = useLabelMatch("Sync Now");
  const [staged] = useSetting<string>("settingsSync.repository");
  const applied = useAppliedSetting<string>("settingsSync.repository").trim();
  const pending = staged.trim() !== applied;
  return (
    <div className={clsx(styles.syncRow, matched && formStyles.matched)} data-search-match={matched || undefined}>
      <Button disabled={!canSync || pending || !applied} onClick={() => void executeAction("file.syncSettings")}>
        <SearchLabel text="Sync Now" />
      </Button>
      {(pending || !applied) && (
        <span className={styles.syncHint}>
          {pending ? tx("Apply the changes first.") : tx("Enter a repository URL first.")}
        </span>
      )}
    </div>
  );
}

export const SETTINGS_SYNC_PAGE: PageSpec = {
  id: "general.settingsSync",
  title: "Settings Sync",
  order: 4,
  keywords: ["settings repository", "git", "gist", "backup", "share settings", "other computer"],
  sections: [
    {
      options: [
        {
          kind: "text",
          key: "settingsSync.repository",
          label: "Repository URL",
          hint: "A Git repository only you can read and write. A secret Gist's clone URL works too, but anyone with its link can read it. Git signs in with your own credentials; OpenIDEA stores none.",
        },
        {
          kind: "toggle",
          key: "settingsSync.auto",
          label: "Sync automatically",
          hint: "On startup and 30 seconds after the settings change. Templates and macros sync on startup and with Sync Now.",
        },
        { kind: "custom", label: "Sync Now", component: SyncNowRow },
      ],
    },
    {
      title: "Sync",
      options: [
        { kind: "toggle", key: "settingsSync.appearance", label: "Appearance and themes" },
        {
          kind: "toggle",
          key: "settingsSync.editor",
          label: "Editor",
          hint: "Fonts, color schemes, code style, inspections and spelling.",
        },
        { kind: "toggle", key: "settingsSync.keymaps", label: "Keymaps" },
        { kind: "toggle", key: "settingsSync.templates", label: "Live, file and postfix templates" },
        { kind: "toggle", key: "settingsSync.macros", label: "Macros" },
        { kind: "toggle", key: "settingsSync.ui", label: "Tool window layouts and view options" },
        {
          kind: "toggle",
          key: "settingsSync.other",
          label: "Other settings",
          hint: "Never synced: passwords and tokens, environment variables, arguments, commands and paths, proxy, SSH, deployment, run targets, the download mirror, the MCP server and agent permissions.",
        },
      ],
    },
  ],
};
