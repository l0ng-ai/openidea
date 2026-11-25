import { useI18n } from "./i18n";

export const DEFAULT_REMOTE_IDLE_MINUTES = 180;
export const MAX_REMOTE_IDLE_MINUTES = 65535;

/** Zero is an explicit Never, not the fallback for malformed or missing settings. */
export function validRemoteIdleMinutes(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_REMOTE_IDLE_MINUTES
    ? value
    : DEFAULT_REMOTE_IDLE_MINUTES;
}

/** Use the largest whole unit so neither a saved minute nor a host-enforced second gets rounded. */
export function formatIdleDuration(seconds: number): string {
  const [unit, scale] =
    seconds % 86400 === 0
      ? (["day", 86400] as const)
      : seconds % 3600 === 0
        ? (["hour", 3600] as const)
        : seconds % 60 === 0
          ? (["minute", 60] as const)
          : (["second", 1] as const);
  return new Intl.NumberFormat(useI18n.getState().locale, { style: "unit", unit, unitDisplay: "long" }).format(
    seconds / scale,
  );
}
