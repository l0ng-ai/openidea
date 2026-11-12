/**
 * `[[contributes.secrets]]` on the plugin details page: a password field per
 * declared secret. Values go to the backend's secret store (the macOS
 * Keychain in the desktop app) and never come back to the UI; plugins use
 * them only as `{{secret:<name>}}` placeholders in `net` request headers.
 */
import { useCallback, useEffect, useState } from "react";
import type { PluginInfo, PluginSecretState } from "@/bindings";
import { tx } from "@/platform/i18n";
import { Badge, Button, Input, T } from "@/ui";
import { pluginsBackend } from "./backend";
import type { UiItem } from "./projection";
import styles from "./PluginsPage.module.css";

export interface SecretDecl {
  name: string;
  label: string;
  description?: string | null;
}

function SecretRow({
  plugin,
  decl,
  isSet,
  onChanged,
}: {
  plugin: PluginInfo;
  decl: SecretDecl;
  isSet: boolean;
  onChanged: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (v: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await pluginsBackend().setSecret(plugin.id, decl.name, v);
      setValue("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={styles.item}>
      <span className={styles.itemMain} title={decl.description ?? undefined}>
        {decl.label}
      </span>
      {isSet ? <Badge tone="success">{tx("Stored")}</Badge> : <Badge tone="neutral">{tx("Not set")}</Badge>}
      <Input
        type="password"
        value={value}
        disabled={busy}
        placeholder={isSet ? "Replace…" : "Value"}
        aria-label={tx`Value of ${decl.label}`}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value) void save(value);
        }}
      />
      <Button size="small" variant="ghost" disabled={busy || !value} onClick={() => void save(value)}>
        <T>Save</T>
      </Button>
      {isSet && (
        <Button
          size="small"
          variant="ghost"
          disabled={busy}
          onClick={() => void save(null)}
          aria-label={tx`Remove ${decl.label}`}
        >
          <T>Remove</T>
        </Button>
      )}
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </li>
  );
}

export function SecretsDetails({ plugin, items }: { plugin: PluginInfo; items: UiItem<SecretDecl>[] }) {
  const [state, setState] = useState<PluginSecretState[]>([]);
  const refresh = useCallback(() => {
    pluginsBackend()
      .secrets(plugin.id)
      .then(setState, () => setState([]));
  }, [plugin.id]);
  useEffect(refresh, [refresh]);
  return (
    <>
      <ul className={styles.items} aria-label={tx("Secrets")}>
        {items.map(({ decl }) => (
          <SecretRow
            key={decl.name}
            plugin={plugin}
            decl={decl}
            isSet={state.some((s) => s.name === decl.name && s.set)}
            onChanged={refresh}
          />
        ))}
      </ul>
      <div className={styles.muted}>
        <T>The plugin can only send these with its network requests; it cannot read them.</T>
      </div>
    </>
  );
}
