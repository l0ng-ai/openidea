/**
 * Why a debug session didn't start, as the user reads it. An adapter that listens for
 * the debuggee (php-debug waiting for Xdebug) fails with Node's
 * `listen EADDRINUSE: address already in use :::9003` when another IDE holds the port.
 */
import { tx } from "@/platform/i18n";

const PORT_IN_USE = /\bEADDRINUSE\b.*:(\d+)\s*$/;

export function startFailureMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const port = PORT_IN_USE.exec(message)?.[1];
  return port
    ? tx`Port ${port} is already in use: another IDE or debug session may be listening on it. Stop it or choose another port.`
    : message;
}
