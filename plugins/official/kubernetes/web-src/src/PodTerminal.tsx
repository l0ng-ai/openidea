import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface PodTerminalProps {
  context: string;
  namespace: string;
  pod: string;
  container: string;
  kind?: "Pod" | "Node";
}

const ptyListeners = new Map<string, (msg: { op: string; data?: string; exitCode?: number | null }) => void>();

export function dispatchPtyEvent(msg: { op: string; sessionId?: string; data?: string; exitCode?: number | null }) {
  if (!msg.sessionId) return;
  ptyListeners.get(msg.sessionId)?.(msg);
}

function sendPtyMessage(payload: Record<string, unknown>) {
  if (typeof window !== "undefined" && window.openidea) {
    window.openidea.postMessage(JSON.stringify(payload));
  }
}

export function PodTerminal({ context, namespace, pod, container, kind = "Pod" }: PodTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const sessionId = `k8s-pty-${kind}-${context}-${namespace}-${pod}-${container}`;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: 'var(--fl-mono, "SF Mono", Menlo, Monaco, Consolas, monospace)',
      fontSize: 12.5,
      lineHeight: 1.35,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: {
        background: "#14171a",
        foreground: "#e6edf3",
        cursor: "#00a7a0",
        selectionBackground: "rgba(0, 167, 160, 0.32)",
        black: "#14171a",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#e6edf3",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);

    try {
      fitAddon.fit();
    } catch {
      // ignore initial 0x0 fit
    }

    const args: string[] = [];
    if (context) args.push(`--context=${context}`);
    if (kind === "Node") {
      args.push(
        "debug",
        `node/${pod}`,
        "-it",
        "--image=busybox:latest",
        "--",
        "/bin/sh",
        "-c",
        "export TERM=xterm-256color; if [ -d /host ]; then exec chroot /host /bin/sh -c 'if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi'; else exec /bin/sh; fi",
      );
    } else {
      if (namespace) args.push("-n", namespace);
      args.push("exec", pod);
      if (container) args.push(`--container=${container}`);
      args.push(
        "--stdin=true",
        "--tty=true",
        "--",
        "/bin/sh",
        "-c",
        "export TERM=xterm-256color; if [ -x /bin/bash ]; then exec /bin/bash; elif [ -x /bin/ash ]; then exec /bin/ash; else exec /bin/sh; fi",
      );
    }

    ptyListeners.set(sessionId, (msg) => {
      if (msg.op === "pty-data" && typeof msg.data === "string") {
        term.write(msg.data);
      } else if (msg.op === "pty-exit") {
        term.writeln(
          `\r\n\x1b[33m[Session ended${typeof msg.exitCode === "number" ? ` (exit code ${msg.exitCode})` : ""} — press Enter to reconnect]\x1b[0m`,
        );
      }
    });

    let exited = false;
    const origListener = ptyListeners.get(sessionId)!;
    ptyListeners.set(sessionId, (msg) => {
      if (msg.op === "pty-exit") exited = true;
      origListener(msg);
    });

    const spawnPty = () => {
      exited = false;
      sendPtyMessage({
        op: "pty-spawn",
        sessionId,
        program: "kubectl",
        args,
        cols: Math.max(40, term.cols),
        rows: Math.max(10, term.rows),
      });
    };

    spawnPty();

    const dataSub = term.onData((data) => {
      if (exited && (data === "\r" || data === "\n")) {
        term.clear();
        spawnPty();
        return;
      }
      sendPtyMessage({
        op: "pty-input",
        sessionId,
        data,
      });
    });

    const resizeSub = term.onResize(({ cols, rows }) => {
      sendPtyMessage({
        op: "pty-resize",
        sessionId,
        cols,
        rows,
      });
    });

    const ro = new ResizeObserver(() => {
      if (!host.isConnected || host.offsetWidth === 0 || host.offsetHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    });
    ro.observe(host);

    requestAnimationFrame(() => term.focus());

    return () => {
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      ptyListeners.delete(sessionId);
      sendPtyMessage({ op: "pty-kill", sessionId });
      term.dispose();
    };
  }, [kind, context, namespace, pod, container]);

  return (
    <div ref={hostRef} style={{ flex: 1, width: "100%", height: "100%", padding: "6px 8px", overflow: "hidden" }} />
  );
}
