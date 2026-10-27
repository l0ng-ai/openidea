/** Picks one of Settings › Tools › SSH Configurations (always the global list). */
import { tx } from "@/platform/i18n";
import { sshLabel, type SshConfigValid } from "@/platform/remoteSettings";
import type { SelectOption } from "@/ui";
import { Select } from "./Form";
import { useSetting } from "./context";

export function useSshConfigs(): SshConfigValid[] {
  const [configs] = useSetting<SshConfigValid[] | undefined>("ssh.configs", "global");
  return configs ?? [];
}

export function SshConfigSelect({
  value,
  onChange,
  none,
  "aria-label": ariaLabel = "SSH configuration",
}: {
  value: string;
  onChange: (id: string) => void;
  /** Label of an empty choice (e.g. "Local machine"); omitted: no empty choice. */
  none?: string;
  "aria-label"?: string;
}) {
  const configs = useSshConfigs();
  const options: SelectOption[] = [
    ...(none !== undefined ? [{ value: "", label: none }] : []),
    ...configs.map((c) => ({ value: c.id, label: c.name.trim() || sshLabel(c), detail: sshLabel(c) })),
  ];
  if (value && !configs.some((c) => c.id === value)) options.push({ value, label: tx`${value} (missing)` });
  if (options.length === 0) options.push({ value: "", label: "No SSH configurations", disabled: true });
  return <Select value={value} options={options} onChange={onChange} aria-label={ariaLabel} />;
}
