/**
 * The startup migration prompt after a configuration-directory switch: the
 * previous location's files are offered for moving into the new one. Migrate
 * rewrites old absolute paths in settings and run configurations, trashes
 * the previous directories (recoverable) and restarts; "Don't migrate"
 * keeps them in place — optionally without ever asking again.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import type { MigrationStatus } from "@/platform/ipc";
import { call, commands, isTauri } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Checkbox, Dialog, T } from "@/ui";
import { notifications } from "@/workbench/contributions";

const useOpen = create<{ open: boolean }>(() => ({ open: false }));

/** Silent check once per app start; the dialog opens only when something can move. */
export async function checkMigrationOnStartup(): Promise<void> {
  if (!isTauri()) return;
  // Only the main window prompts: settings and project windows spawn later
  // and re-run activation, and one dialog is enough (a migration restarts
  // the app).
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  if (getCurrentWindow().label !== "main") return;
  const status = await commands.migrationStatus().catch(() => null);
  if (status?.pending) useOpen.setState({ open: true });
}

const close = () => useOpen.setState({ open: false });

/** Migrate, then restart: this start's state was read from the new location. */
async function migrateAndRestart(): Promise<void> {
  close();
  let moved = 0;
  let failed = 0;
  try {
    const result = await commands.migrationApply();
    moved = result.moved;
    failed = result.failed;
  } catch (e) {
    notifications().notify({
      level: "error",
      title: tx("Migration failed"),
      body: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  if (failed > 0) {
    // The previous directories are kept: nothing was lost, the next start asks again.
    notifications().notify({
      level: "warning",
      title: tx("Migration incomplete"),
      body: tx`Moved ${moved} entries; ${failed} could not be moved and stay in the old directories.`,
    });
    return;
  }
  await commands.appRestart();
}

async function decline(remember: boolean): Promise<void> {
  close();
  // Only the choice with "don't ask again" is recorded; a plain decline
  // prompts again on the next start.
  await call(commands.migrationDecline(remember)).catch(() => undefined);
}

/** The registered overlay (id `app.migration`): a dialog asking whether to
 * move the previous location's data after a configuration-directory switch. */
export function MigrationOverlay() {
  const open = useOpen((s) => s.open);
  const [remember, setRemember] = useState(false);
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  useEffect(() => {
    if (open)
      void commands
        .migrationStatus()
        .then(setStatus)
        .catch(() => setStatus(null));
  }, [open]);
  if (!open) return null;
  return (
    <Dialog
      open
      title={<T>Move configuration to the new directory?</T>}
      onClose={() => void decline(false)}
      width={520}
      footerStart={<Checkbox label={<T>Don't ask again</T>} checked={remember} onChange={setRemember} />}
      buttons={[
        {
          label: "Migrate",
          role: "default",
          autoFocus: true,
          onClick: () => void migrateAndRestart(),
        },
        { label: "Don't migrate", role: "cancel", onClick: () => void decline(remember) },
      ]}
    >
      <p>
        <T>
          Data was found in the previous location. Migrating moves its settings, tools and language servers to the new
          directory.
        </T>
      </p>
      {status && (
        <p>
          {status.from.map((dir) => (
            <div key={dir}>{dir}</div>
          ))}
          <div>↓</div>
          {status.to.map((dir) => (
            <div key={dir}>{dir}</div>
          ))}
          {status.entries > 0 ? tx`${status.entries} entries` : ""}
        </p>
      )}
      <p>
        <T>
          Old paths in settings and run configurations are rewritten, and the previous directories are moved to the
          trash. Don't migrate keeps them in place; the prompt asks again on the next start.
        </T>
      </p>
    </Dialog>
  );
}
