/**
 * Appearance & Behavior › System Settings › HTTP Proxy: how the IDE's own
 * connections (HTTP Client, tool / JDK / agent downloads, update checks) reach
 * the network. A manual proxy also reaches child processes as `HTTP_PROXY`.
 */
import { useId, useRef, useState } from "react";
import clsx from "clsx";
import { call, commands, isTauri } from "@/platform/ipc";
import { tx, useTx } from "@/platform/i18n";
import {
  PROXY_PORT_LIMITS,
  proxyProblem,
  withProxyKind,
  type ProxyKindValid,
  type ProxyModeValid,
  type ProxySettingsValid,
} from "@/platform/proxySettings";
import { Button, Checkbox, Input, Popup, T } from "@/ui";
import { NumberInput, Row, SearchLabel } from "../components/Form";
import { usePageContext, useSetting } from "../components/context";
import { stage } from "../model/staging";
import type { PageSpec } from "./spec";
import styles from "./HttpProxy.module.css";

const MODES: Array<{ value: ProxyModeValid; label: string; hint?: string }> = [
  { value: "none", label: "No proxy" },
  {
    value: "auto",
    label: "Auto-detect proxy settings",
    hint: "Uses the system proxy: the HTTP_PROXY, HTTPS_PROXY and NO_PROXY environment variables.",
  },
  { value: "manual", label: "Manual proxy configuration" },
];

const KINDS: Array<{ value: ProxyKindValid; label: string }> = [
  { value: "http", label: "HTTP" },
  { value: "socks", label: "SOCKS" },
];

/** The staged proxy settings and a setter per field (each written as its own key). */
function useProxy(): [ProxySettingsValid, (patch: Partial<ProxySettingsValid>) => void] {
  const [proxy] = useSetting<ProxySettingsValid>("proxy", "global");
  const { pageId } = usePageContext();
  const update = (patch: Partial<ProxySettingsValid>) => {
    for (const [field, value] of Object.entries(patch)) stage(pageId, "global", `proxy.${field}`, value);
  };
  return [proxy, update];
}

function Radio({
  name,
  checked,
  onSelect,
  label,
  disabled,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className={clsx(styles.radio, disabled && styles.disabled)}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onSelect} />
      <SearchLabel text={label} />
    </label>
  );
}

function ProxyOptions() {
  const [proxy, update] = useProxy();
  const name = useId();
  const kindName = useId();
  const ids = {
    host: useId(),
    port: useId(),
    noProxy: useId(),
    login: useId(),
    password: useId(),
  };
  const manual = proxy.mode === "manual";
  const auth = manual && proxy.authenticate;
  const problem = proxyProblem(proxy);
  return (
    <div className={styles.page}>
      <div className={styles.modes} role="radiogroup" aria-label={tx("Proxy")}>
        {MODES.map((m) => (
          <div key={m.value}>
            <Radio
              name={name}
              checked={proxy.mode === m.value}
              onSelect={() => update({ mode: m.value })}
              label={m.label}
            />
            {m.hint && (
              <div className={styles.hint}>
                <T>{m.hint}</T>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className={styles.manual}>
        <div className={styles.kinds} role="radiogroup" aria-label={tx("Proxy type")}>
          {KINDS.map((k) => (
            <Radio
              key={k.value}
              name={kindName}
              checked={proxy.kind === k.value}
              disabled={!manual}
              onSelect={() => update(withProxyKind(proxy, k.value))}
              label={k.label}
            />
          ))}
        </div>
        <div className={styles.hostRow}>
          <Row label="Host name" htmlFor={ids.host}>
            <Input
              id={ids.host}
              className={styles.host}
              disabled={!manual}
              value={proxy.host}
              onChange={(e) => update({ host: e.target.value })}
            />
          </Row>
          <Row label="Port number" htmlFor={ids.port}>
            {manual ? (
              <NumberInput
                id={ids.port}
                value={proxy.port}
                onChange={(port) => update({ port })}
                {...PROXY_PORT_LIMITS}
                integer
                aria-label="Port number"
              />
            ) : (
              <Input id={ids.port} className={styles.port} value={String(proxy.port)} disabled readOnly />
            )}
          </Row>
        </div>
        <Row
          label="No proxy for"
          htmlFor={ids.noProxy}
          hint="Comma-separated host names; * matches any characters, e.g. *.example.com, 192.168.*"
        >
          <Input
            id={ids.noProxy}
            className={styles.wide}
            disabled={!manual}
            value={proxy.noProxy}
            onChange={(e) => update({ noProxy: e.target.value })}
          />
        </Row>
        <div className={styles.toggle}>
          <Checkbox
            checked={proxy.authenticate}
            disabled={!manual}
            onChange={(authenticate) => update({ authenticate })}
            label={<SearchLabel text="Proxy authentication" />}
          />
        </div>
        <div className={styles.auth}>
          <Row label="Login" htmlFor={ids.login}>
            <Input
              id={ids.login}
              className={styles.host}
              disabled={!auth}
              value={proxy.login}
              onChange={(e) => update({ login: e.target.value })}
            />
          </Row>
          <Row label="Password" htmlFor={ids.password}>
            <Input
              id={ids.password}
              type="password"
              className={styles.host}
              disabled={!auth}
              value={proxy.password}
              onChange={(e) => update({ password: e.target.value })}
            />
          </Row>
        </div>
        {problem && (
          <div className={styles.error} role="alert">
            <T>{problem}</T>
          </div>
        )}
      </div>
      <CheckConnection proxy={proxy} />
    </div>
  );
}

type CheckState = { status: "idle" | "running" } | { status: "ok" | "failed"; text: string };

/** Check connection…: asks for a URL and GETs it with the settings as edited. */
function CheckConnection({ proxy }: { proxy: ProxySettingsValid }) {
  const t = useTx();
  const anchor = useRef<HTMLButtonElement>(null);
  const urlId = useId();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("http://");
  const [state, setState] = useState<CheckState>({ status: "idle" });
  const check = async () => {
    setState({ status: "running" });
    try {
      const status = await call(commands.proxyCheckConnection(proxy, url));
      setState({ status: "ok", text: t`Connection successful: ${status}` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({
        status: "failed",
        text: t`Problem with connection: ${message}`,
      });
    }
  };
  const running = state.status === "running";
  return (
    <div className={styles.check}>
      <Button
        ref={anchor}
        size="small"
        disabled={!isTauri() || !!proxyProblem(proxy)}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <T>Check connection…</T>
      </Button>
      <Popup
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        placement="bottom-start"
        offset={4}
        aria-label="Check connection"
      >
        <form
          className={styles.popup}
          onSubmit={(e) => {
            e.preventDefault();
            if (!running && url.trim()) void check();
          }}
        >
          <label htmlFor={urlId}>
            <T>Enter any URL to check connection to:</T>
          </label>
          <span className={styles.urlRow}>
            <Input id={urlId} autoFocus className={styles.wide} value={url} onChange={(e) => setUrl(e.target.value)} />
            <Button size="small" type="submit" disabled={running || !url.trim()}>
              <T>Check</T>
            </Button>
          </span>
          <span
            role="status"
            className={clsx(
              styles.result,
              state.status === "ok" && styles.ok,
              state.status === "failed" && styles.error,
            )}
          >
            {state.status === "ok" || state.status === "failed" ? state.text : running ? t("Connecting…") : ""}
          </span>
        </form>
      </Popup>
    </div>
  );
}

export const HTTP_PROXY_PAGE: PageSpec = {
  id: "general.httpProxy",
  title: "HTTP Proxy",
  order: 2,
  keywords: ["proxy", "network", "socks", "http_proxy", "no_proxy", "connection"],
  sections: [
    {
      options: [
        {
          kind: "custom",
          label: "Manual proxy configuration",
          keywords: [
            "No proxy",
            "Auto-detect proxy settings",
            "Host name",
            "Port number",
            "No proxy for",
            "Proxy authentication",
            "Login",
            "Password",
            "Check connection…",
          ],
          component: ProxyOptions,
        },
      ],
    },
  ],
};
