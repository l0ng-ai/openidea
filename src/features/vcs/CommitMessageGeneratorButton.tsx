/** Commit-panel entry for installed message generator plugins. */
import { useRef, useState } from "react";
import { usePlugins } from "@/features/plugins/store";
import { tx } from "@/platform/i18n";
import { IconButton, Menu } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { generateCommitMessage } from "./commitMessageGeneratorRuntime";

export function CommitMessageGeneratorButton({ included }: { included: number }) {
  const plugins = usePlugins((state) => state.plugins);
  const providers = plugins.filter(
    (plugin) =>
      plugin.enabled &&
      plugin.status === "active" &&
      (plugin.permissions as readonly string[]).includes("ai-completions"),
  );
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!providers.length) return null;
  const run = async (pluginId: string) => {
    setBusy(true);
    try {
      await generateCommitMessage(pluginId);
    } catch (error) {
      const body = error instanceof Error ? error.message : String(error);
      notifications().notify({ group: "vcs", level: "error", title: tx("Could not generate commit message"), body });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <IconButton
        ref={anchor}
        icon={busy ? "refresh" : "star"}
        size="small"
        title={busy ? tx("Generating Commit Message…") : tx("Generate Commit Message")}
        disabled={busy || !included}
        aria-haspopup={providers.length > 1 ? "menu" : undefined}
        aria-expanded={providers.length > 1 ? open : undefined}
        onClick={() => (providers.length === 1 ? void run(providers[0]!.id) : setOpen(true))}
      />
      {providers.length > 1 && (
        <Menu
          open={open}
          anchor={anchor}
          onClose={() => setOpen(false)}
          placement="bottom-end"
          aria-label={tx("Commit message providers")}
          items={providers.map((plugin) => ({
            id: plugin.id,
            label: plugin.name,
            verbatim: true,
            run: () => void run(plugin.id),
          }))}
        />
      )}
    </>
  );
}
