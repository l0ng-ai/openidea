/** The Hermes profile a task runs in, next to the model picker. */
import { useEffect, useState } from "react";
import type { HermesProfile } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Icon, Select } from "@/ui";
import { hermesAgentId, providerIcon } from "./model";
import { refreshProviders, useAgents } from "./store";

const isHermes = (provider: string | undefined) => provider === "hermes" || !!provider?.startsWith("hermes-");

/** The profiles on this computer; empty for other agents or without Hermes. */
function useHermesProfiles(provider: string | undefined): HermesProfile[] {
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const hermes = isHermes(provider);
  useEffect(() => {
    if (!hermes) return;
    let live = true;
    void call(commands.agentHermesProfiles())
      .then((list) => live && setProfiles(list))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [hermes]);
  return hermes ? profiles : [];
}

/** The profile `provider` runs in, by the name Hermes shows for it. */
const hermesProfileOf = (profiles: readonly HermesProfile[], provider: string) =>
  profiles.find((p) => hermesAgentId(p.name) === provider) ?? null;

/**
 * Each profile is an agent of its own (`hermes -p <name> acp`, `hermes` for `default`), made
 * on first choice, so the agent picker's memory keeps the profile like it keeps the model.
 */
export function HermesProfilePicker({
  provider,
  onChange,
}: {
  provider: string | undefined;
  /** Without it the picker only shows the profile: a session stays in the one it started in. */
  onChange?: (provider: string) => void;
}) {
  const tx = useTx();
  const profiles = useHermesProfiles(provider);
  const providers = useAgents((s) => s.providers);
  if (!provider || profiles.length < 2) return null;
  const choose = async (name: string) => {
    const id = hermesAgentId(name);
    if (!providers.some((p) => p.id === id)) {
      const label = profiles.find((p) => p.name === name)?.label ?? name;
      await call(
        commands.agentCustomSave({ id, name: `Hermes (${label})`, command: "hermes", args: ["-p", name, "acp"] }),
      );
      await refreshProviders();
    }
    onChange?.(id);
  };
  return (
    <Select
      variant="ghost"
      aria-label={tx("Hermes profile")}
      disabled={!onChange}
      value={hermesProfileOf(profiles, provider)?.name ?? null}
      options={profiles.map((p) => ({ value: p.name, label: p.label, verbatim: true }))}
      renderValue={(o) => (
        <>
          <Icon name={providerIcon(provider)} size={14} /> {o?.label ?? provider}
        </>
      )}
      onChange={(name) => void choose(name)}
    />
  );
}
