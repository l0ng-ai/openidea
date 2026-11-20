import { useId, useState } from "react";
import { tx, useTx } from "@/platform/i18n";
import { useRemote } from "@/platform/remote";
import { DEFAULT_REMOTE_IDLE_MINUTES, MAX_REMOTE_IDLE_MINUTES, formatIdleDuration } from "@/platform/remoteIdle";
import { Input, Select } from "@/ui";
import { Row } from "../components/Form";
import { useSetting } from "../components/context";
import type { PageSpec } from "./spec";
import { TOOLS_GROUP } from "./tools";
import styles from "./Pages.module.css";

const PRESETS = [30, 60, DEFAULT_REMOTE_IDLE_MINUTES, 480, 1440];
const SCALES = { minutes: 1, hours: 60, days: 1440 };
type Unit = keyof typeof SCALES;

function CustomDuration({ minutes, setMinutes }: { minutes: number; setMinutes: (n: number) => void }) {
  const id = useId();
  const [unit, setUnit] = useState<Unit>(() =>
    minutes % 1440 === 0 ? "days" : minutes % 60 === 0 ? "hours" : "minutes",
  );
  const [draft, setDraft] = useState<string | null>(null);
  const scale = SCALES[unit];
  // Changing the unit only changes the display; it must never round or stage a new timeout.
  const display = (n: number) => String(Number((n / scale).toFixed(6)));
  const parse = (text: string) => {
    const decimal = text.trim().replace(",", ".");
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(decimal)) return null;
    const value = Number(decimal) * scale;
    const rounded = Math.round(value);
    if (rounded < 1 || rounded > MAX_REMOTE_IDLE_MINUTES) return null;
    if (Number(decimal) === Number(display(minutes))) return minutes;
    return Math.abs(value - rounded) <= Number.EPSILON * Math.max(1, value) ? rounded : null;
  };
  const invalid = draft !== null && parse(draft) === null;
  return (
    <Row
      label="Custom duration"
      htmlFor={id}
      hint={invalid ? tx("Enter a duration equivalent to 1–65,535 whole minutes.") : undefined}
    >
      <Input
        id={id}
        className={styles.durationAmount}
        inputMode="decimal"
        invalid={invalid}
        value={draft ?? display(minutes)}
        onChange={(e) => {
          setDraft(e.target.value);
          const next = parse(e.target.value);
          if (next !== null) setMinutes(next);
        }}
        onBlur={() => setDraft(null)}
      />
      <Select<Unit>
        aria-label="Duration unit"
        value={unit}
        options={[
          { value: "minutes", label: "Minutes" },
          { value: "hours", label: "Hours" },
          { value: "days", label: "Days" },
        ]}
        onChange={(next) => {
          setUnit(next);
          setDraft(null);
        }}
      />
    </Row>
  );
}

function IdleTimeout() {
  const tr = useTx();
  const session = useRemote((s) => s.session);
  const disconnected = useRemote((s) => s.lost !== null);
  const [minutes, setMinutes] = useSetting<number>("remoteDevelopment.idleTimeoutMinutes");
  const [customAt, setCustomAt] = useState<number | null>(null);
  const id = useId();
  const host = session?.host;
  const seconds = session?.idlePolicy?.overrideSeconds;
  if (session && !disconnected && seconds != null) {
    return (
      <Row label="Stop backend when idle" hint={tr`Set by OPENIDEA_SERVER_IDLE_TIMEOUT_SECONDS on ${host}.`}>
        {formatIdleDuration(seconds)}
      </Row>
    );
  }
  const disabled = !session?.idlePolicy || disconnected;
  const value =
    minutes === 0 ? "never" : customAt === minutes || !PRESETS.includes(minutes) ? "custom" : String(minutes);
  const hint = !session
    ? tr("Open Settings in a remote project window to change its backend timeout.")
    : disconnected
      ? tr("Reconnect to the remote host to change its backend timeout.")
      : !session.idlePolicy
        ? tr("This backend does not support a configurable idle timeout.")
        : minutes === 0
          ? tr`Idle shutdown is off on ${host}. You can still stop the backend manually.`
          : tr`The timer starts when the last window disconnects from ${host} and no terminals, runs, debug sessions, or agent tasks are active.`;
  const custom = (next: number) => {
    setCustomAt(next);
    setMinutes(next);
  };
  return (
    <>
      <Row label="Stop backend when idle" htmlFor={id} hint={hint} disabled={disabled}>
        <Select
          id={id}
          aria-label="Stop backend when idle"
          disabled={disabled}
          value={value}
          options={[
            ...PRESETS.map((n) => {
              const duration = formatIdleDuration(n * 60);
              return {
                value: String(n),
                label: n === DEFAULT_REMOTE_IDLE_MINUTES ? tr`After ${duration} (default)` : tr`After ${duration}`,
              };
            }),
            { value: "custom", label: "Custom…" },
            { value: "never", label: "Never" },
          ]}
          onChange={(next) => {
            if (next === "custom") custom(minutes || DEFAULT_REMOTE_IDLE_MINUTES);
            else {
              setCustomAt(null);
              setMinutes(next === "never" ? 0 : Number(next));
            }
          }}
        />
      </Row>
      {!disabled && value === "custom" && <CustomDuration minutes={minutes} setMinutes={custom} />}
    </>
  );
}

export const REMOTE_DEVELOPMENT_PAGE: PageSpec = {
  id: "tools.remoteDevelopment",
  title: "Remote Development",
  group: TOOLS_GROUP,
  order: 604,
  keywords: ["SSH", "WSL", "dev container", "disconnect", "shutdown", "idle timeout"],
  sections: [
    {
      title: "Remote backend",
      options: [
        {
          kind: "custom",
          label: "Stop backend when idle",
          keywords: ["Idle timeout", "Custom duration", "Never"],
          component: IdleTimeout,
        },
      ],
    },
  ],
};
