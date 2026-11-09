/**
 * Ports tool window of a remote window: ports of the remote host forwarded to this machine
 * (`localhost:<port>` here reaches `localhost:<port>` there), like VS Code's Ports view.
 */
import { useEffect, useState } from "react";
import type { ForwardedPort } from "@/bindings";
import { tx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { Button, EmptyState, IconButton, Input, T, copyText } from "@/ui";
import { forwardPort, parsePort, refreshPorts, stopForwarding, usePorts } from "./ports";
import styles from "./Ports.module.css";

const address = (p: ForwardedPort) => `localhost:${p.localPort}`;

export function PortsView() {
  const ports = usePorts((s) => s.ports);
  const [input, setInput] = useState("");
  const port = parsePort(input);

  useEffect(() => {
    void refreshPorts();
  }, []);

  const submit = async () => {
    if (port === null) return;
    if (await forwardPort(port)) setInput("");
  };

  return (
    <div className={styles.view}>
      <form
        className={styles.add}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          aria-label="Remote port"
          className={styles.input}
          inputMode="numeric"
          placeholder={tx("Remote port, e.g. 3000")}
          value={input}
          invalid={input.trim() !== "" && port === null}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            void submit();
          }}
        />
        <Button size="small" type="submit" disabled={port === null}>
          <T>Forward Port</T>
        </Button>
      </form>
      {ports.length === 0 ? (
        <EmptyState title="No forwarded ports">
          <T>Forward a port of the remote host to reach it from this machine, e.g. a web server in a browser.</T>
        </EmptyState>
      ) : (
        <ul className={styles.list} aria-label={tx("Forwarded ports")}>
          {ports.map((p) => {
            const addr = address(p);
            return (
              <li key={p.remotePort} className={styles.row}>
                <span className={styles.remote}>{p.remotePort}</span>
                <span className={styles.arrow} aria-hidden>
                  →
                </span>
                <span className={styles.local}>{addr}</span>
                <span className={styles.actions}>
                  <IconButton
                    icon="web"
                    size="small"
                    title={tx`Open ${addr} in Browser`}
                    onClick={() => void openExternalUrl(`http://${addr}/`)}
                  />
                  <IconButton icon="copy" size="small" title={tx`Copy ${addr}`} onClick={() => void copyText(addr)} />
                  <IconButton
                    icon="close"
                    size="small"
                    title={tx`Stop Forwarding Port ${p.remotePort}`}
                    onClick={() => void stopForwarding(p.remotePort)}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
