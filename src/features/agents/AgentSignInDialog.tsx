/**
 * Interactive sign-in dialog for coding agents (`copilot login`, `codex login`, `claude`, …),
 * backed by an IDE-managed PTY (`agent_login_spawn`) and a lazily loaded embedded terminal widget.
 */
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { AgentLoginEvent, TerminalId } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Dialog, Spinner, T } from "@/ui";
import { embeddedTerminal, type EmbeddedTerminal, type EmbeddedTerminalFactory } from "@/workbench/contributions";
import styles from "./AgentSignInDialog.module.css";

export type SignInTarget = { kind: "agent"; id: string; name: string };

export interface SignInSpawner {
  loginSpawn?(id: string, cols: number, rows: number, onEvent: (e: AgentLoginEvent) => void): Promise<TerminalId>;
}

const defaultSpawner: Required<SignInSpawner> = {
  loginSpawn: async (id, cols, rows, onEvent) => {
    const channel = new Channel<AgentLoginEvent>();
    channel.onmessage = onEvent;
    const info = await call(commands.agentLoginSpawn(id, cols, rows, channel));
    return info.id;
  },
};

async function loadTerminalFactory(): Promise<EmbeddedTerminalFactory> {
  const registered = embeddedTerminal();
  if (registered) return registered;
  const mod = await import("@/features/terminal/embedded");
  return async (host, opts) => mod.createEmbeddedTerminal(host, opts);
}

export function AgentSignInDialog({
  target,
  spawner,
  onClose,
  onCompleted,
}: {
  target: SignInTarget;
  spawner?: SignInSpawner;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ptyIdRef = useRef<TerminalId | null>(null);
  const completedRef = useRef(false);
  const callbacksRef = useRef({ onClose, onCompleted, spawner });
  useEffect(() => {
    callbacksRef.current = { onClose, onCompleted, spawner };
  });

  const [attempt, setAttempt] = useState(0);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agentId = target.id;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let disposed = false;
    let term: EmbeddedTerminal | null = null;
    const pendingOutput: string[] = [];
    let pendingSize: { cols: number; rows: number } = { cols: 80, rows: 18 };
    completedRef.current = false;
    setExitCode(null);
    setError(null);

    const killPty = () => {
      const id = ptyIdRef.current;
      ptyIdRef.current = null;
      if (id !== null) void commands.termKill(id).catch(() => {});
    };

    void (async () => {
      try {
        const factory = await loadTerminalFactory();
        if (disposed) return;
        const instance = await factory(el, {
          onData: (data) => {
            const id = ptyIdRef.current;
            if (id !== null) void commands.termWrite(id, data).catch(() => {});
          },
          onResize: (cols, rows) => {
            pendingSize = { cols, rows };
            const id = ptyIdRef.current;
            if (id !== null) void commands.termResize(id, cols, rows).catch(() => {});
          },
        });
        if (disposed) {
          instance.dispose();
          return;
        }
        term = instance;
        for (const chunk of pendingOutput.splice(0)) {
          term.write(chunk);
        }
        term.focus();
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
        return;
      }

      const onEvent = (event: AgentLoginEvent) => {
        if (disposed) return;
        if (event.type === "output") {
          if (term) term.write(event.data);
          else pendingOutput.push(event.data);
        } else {
          ptyIdRef.current = null;
          const code = event.code ?? -1;
          setExitCode(code);
          if (code === 0 && !completedRef.current) {
            completedRef.current = true;
            callbacksRef.current.onCompleted();
            callbacksRef.current.onClose();
          }
        }
      };

      try {
        const custom = callbacksRef.current.spawner;
        const ptyId = await (custom?.loginSpawn ?? defaultSpawner.loginSpawn)(
          agentId,
          pendingSize.cols,
          pendingSize.rows,
          onEvent,
        );
        if (disposed) {
          void commands.termKill(ptyId).catch(() => {});
          return;
        }
        ptyIdRef.current = ptyId;
        void commands.termResize(ptyId, pendingSize.cols, pendingSize.rows).catch(() => {});
        term?.focus();
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      disposed = true;
      killPty();
      term?.dispose();
    };
  }, [agentId, attempt]);

  const running = exitCode === null && !error;
  const title = tx`Sign In to ${target.name}`;

  const finishAndClose = () => {
    const id = ptyIdRef.current;
    ptyIdRef.current = null;
    if (id !== null) void commands.termKill(id).catch(() => {});
    if (!completedRef.current) {
      completedRef.current = true;
      onCompleted();
    }
    onClose();
  };

  const cancelAndClose = () => {
    const id = ptyIdRef.current;
    ptyIdRef.current = null;
    if (id !== null) void commands.termKill(id).catch(() => {});
    onClose();
  };

  return (
    <Dialog
      open
      blockWorkbenchShortcuts
      onClose={cancelAndClose}
      title={title}
      width={640}
      footerStart={
        running ? (
          <span className={styles.status}>
            <Spinner size={12} /> <T>Complete sign-in in your browser or the terminal above…</T>
          </span>
        ) : exitCode !== null && exitCode !== 0 ? (
          <span className={styles.error}>{tx`Sign-in exited with code ${exitCode}.`}</span>
        ) : undefined
      }
      buttons={
        running
          ? [
              { label: "Done", onClick: finishAndClose },
              { label: "Cancel", role: "cancel", onClick: cancelAndClose },
            ]
          : [
              { label: "Retry", role: "default", onClick: () => setAttempt((n) => n + 1) },
              { label: "Close", role: "cancel", onClick: cancelAndClose },
            ]
      }
    >
      <div className={styles.body}>
        <div ref={hostRef} className={styles.terminal} data-autofocus />
        {error && <p className={styles.error}>{error}</p>}
      </div>
    </Dialog>
  );
}
