/**
 * Interactive sign-in dialog for coding agents (`copilot login`, `codex login`, `claude`, …)
 * and GitHub CLI (`gh auth login`), backed by an IDE-managed PTY (`agent_login_spawn` /
 * `agent_gh_login_spawn`) and a lazily loaded embedded terminal widget.
 */
import { useEffect, useRef, useState } from "react";
import type { AgentLoginEvent, TerminalId } from "@/bindings";
import { tx } from "@/platform/i18n";
import { commands } from "@/platform/ipc";
import { Dialog, Spinner, T } from "@/ui";
import { embeddedTerminal, type EmbeddedTerminal } from "@/workbench/contributions";
import styles from "./AgentSignInDialog.module.css";
import { tauriCommands } from "./registry";

export type SignInTarget = { kind: "agent"; id: string; name: string } | { kind: "gh" };

export interface SignInSpawner {
  loginSpawn?(id: string, cols: number, rows: number, onEvent: (e: AgentLoginEvent) => void): Promise<TerminalId>;
  ghLoginSpawn?(cols: number, rows: number, onEvent: (e: AgentLoginEvent) => void): Promise<TerminalId>;
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

  const targetKind = target.kind;
  const agentId = target.kind === "agent" ? target.id : "";

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
        // Provided by the terminal feature (workbench windows) or the Settings window's boot.
        const factory = embeddedTerminal();
        if (!factory) throw new Error(tx("The terminal is not available in this window."));
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
        const ptyId =
          targetKind === "gh"
            ? await (custom?.ghLoginSpawn ?? tauriCommands.ghLoginSpawn!)(pendingSize.cols, pendingSize.rows, onEvent)
            : await (custom?.loginSpawn ?? tauriCommands.loginSpawn!)(
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
  }, [agentId, attempt, targetKind]);

  const running = exitCode === null && !error;
  const title = target.kind === "gh" ? tx("Sign In to GitHub CLI") : tx`Sign In to ${target.name}`;

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
