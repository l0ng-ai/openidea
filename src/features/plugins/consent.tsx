/**
 * The install / permission dialog: every
 * capability with its risk; optional ones can be refused; high-risk ones are
 * called out as running code on this machine.
 */
import { useState } from "react";
import { create } from "zustand";
import type { CapabilityInfo, Consent } from "@/bindings";
import { tx } from "@/platform/i18n";
import { Badge, Checkbox, Dialog, T } from "@/ui";
import { setConsentPrompt, type ConsentRequest } from "./store";
import styles from "./PluginsPage.module.css";

interface Pending {
  req: ConsentRequest;
  resolve: (c: Consent | null) => void;
}

const usePending = create<{ queue: Pending[] }>(() => ({ queue: [] }));

export const RISK_LABEL: Record<CapabilityInfo["risk"], { label: string; tone: "neutral" | "warning" | "danger" }> = {
  low: { label: "Low", tone: "neutral" },
  medium: { label: "Medium", tone: "warning" },
  high: { label: "High", tone: "danger" },
};

const RISK_ORDER = { high: 0, medium: 1, low: 2 } as const;

export function sortByRisk(caps: readonly CapabilityInfo[]): CapabilityInfo[] {
  return [...caps].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.id.localeCompare(b.id));
}

/** Parameterised permission text, translated independently of the granted host/path. */
export function capabilityDescription(cap: CapabilityInfo): string {
  if (cap.id === "database.sources")
    return tx("Manage its own database sources and store their passwords in trusted projects");
  if (cap.id === "ide.commands") {
    return tx(
      "Run any IDE action or other plugins' commands as if you chose them, including running programs, committing and pushing",
    );
  }
  if (cap.id === "net:ask") {
    return tx(
      "Ask to connect to a host that is not on the list the first time it tries; you allow or refuse each host, and can revoke the allowed ones",
    );
  }
  if (cap.id.startsWith("net.http:")) {
    const host = cap.id.slice(9);
    return tx`Connect to ${host} over unencrypted HTTP (from the machine the project is on)`;
  }
  if (cap.id.startsWith("ipc:")) {
    const path = cap.id.slice(4);
    return tx`Connect to local socket ${path} — equivalent to running arbitrary code on the project machine`;
  }
  return tx(cap.description);
}

function ask(req: ConsentRequest): Promise<Consent | null> {
  return new Promise((resolve) => usePending.setState((s) => ({ queue: [...s.queue, { req, resolve }] })));
}

function ConsentDialog({ pending, onDone }: { pending: Pending; onDone: () => void }) {
  const { req } = pending;
  const caps = sortByRisk(req.capabilities);
  const optional = caps.filter((c) => c.optional);
  const [accepted, setAccepted] = useState<Set<string>>(
    () => new Set(optional.filter((c) => c.granted || c.risk === "low").map((c) => c.id)),
  );
  const high = caps.some((c) => c.risk === "high" && (!c.optional || accepted.has(c.id)));
  const finish = (consent: Consent | null) => {
    pending.resolve(consent);
    onDone();
  };
  const title = req.kind === "install" ? tx`Install ${req.name} ${req.version}?` : tx`Allow ${req.name} to run?`;
  return (
    <Dialog
      open
      title={title}
      icon={high ? "warning" : "question"}
      width={520}
      onClose={() => finish(null)}
      buttons={[
        { label: tx("Cancel"), role: "cancel", onClick: () => finish(null) },
        {
          label: req.kind === "install" ? tx("Install") : tx("Allow"),
          role: "default",
          onClick: () => finish({ optional: [...accepted], signerChange: !!req.signerChanged }),
        },
      ]}
    >
      <div className={styles.consent}>
        {req.unsigned && (
          <p className={styles.consentWarning} role="note">
            <T>This package is not signed. Only continue if you trust where it came from.</T>
          </p>
        )}
        {req.signerChanged && (
          <p className={styles.consentWarning} role="alert">
            <T>
              This version is signed with a different key than the installed one, and the publisher's earlier key
              doesn't vouch for it. Only continue if you know the publisher changed keys.
            </T>
          </p>
        )}
        {caps.length === 0 ? (
          <p>
            <T>This plugin needs no special permissions.</T>
          </p>
        ) : (
          <ul className={styles.items} aria-label={tx("Requested permissions")}>
            {caps.map((c) => (
              <li key={c.id} className={styles.capabilityItem}>
                <div className={styles.capabilityHeader}>
                  {c.optional ? (
                    <Checkbox
                      checked={accepted.has(c.id)}
                      onChange={(on) =>
                        setAccepted((s) => {
                          const next = new Set(s);
                          if (on) next.add(c.id);
                          else next.delete(c.id);
                          return next;
                        })
                      }
                      aria-label={tx`Allow ${c.id}`}
                    />
                  ) : (
                    <span className={styles.consentRequired} title={tx("Required")}>
                      •
                    </span>
                  )}
                  <span className={styles.mono}>{c.id}</span>
                  <Badge tone={RISK_LABEL[c.risk].tone}>{RISK_LABEL[c.risk].label}</Badge>
                </div>
                <p className={styles.capabilityDescription}>{capabilityDescription(c)}</p>
              </li>
            ))}
          </ul>
        )}
        {high && (
          <p className={styles.consentWarning} role="alert">
            <T>High-risk permissions are equivalent to running arbitrary code on this machine.</T>
          </p>
        )}
        {req.warnings.map((w) => (
          <p key={w} className={styles.muted}>
            {w}
          </p>
        ))}
      </div>
    </Dialog>
  );
}

/** Overlay rendering the queued consent dialogs one at a time. */
export function ConsentDialogHost() {
  const first = usePending((s) => s.queue[0]);
  if (!first) return null;
  return (
    <ConsentDialog
      key={first.req.pluginId + first.req.kind}
      pending={first}
      onDone={() => usePending.setState((s) => ({ queue: s.queue.slice(1) }))}
    />
  );
}

/** Routes the store's consent requests to the dialog. */
export function provideConsentDialog(): () => void {
  setConsentPrompt(ask);
  return () => {
    setConsentPrompt(null);
    for (const p of usePending.getState().queue) p.resolve(null);
    usePending.setState({ queue: [] });
  };
}
