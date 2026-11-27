/**
 * Why a debug session didn't start, as the user reads it. An adapter that listens for
 * the debuggee (php-debug waiting for Xdebug) fails with Node's
 * `listen EADDRINUSE: address already in use :::9003` when another IDE holds the port.
 */
import { tx } from "@/platform/i18n";

const PORT_IN_USE = /\bEADDRINUSE\b.*:(\d+)\s*$/;
const RUBY_DEBUG_MISSING =
  /^the bundle of (.+) has no `debug` gem\. Add `gem "debug"` to the Gemfile and run `bundle install`$/;

export function startFailureMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const gemfile = RUBY_DEBUG_MISSING.exec(message)?.[1];
  if (gemfile)
    return tx`the bundle of ${gemfile} has no \`debug\` gem. Add \`gem "debug"\` to the Gemfile and run \`bundle install\``;
  const port = PORT_IN_USE.exec(message)?.[1];
  return port
    ? tx`Port ${port} is already in use: another IDE or debug session may be listening on it. Stop it or choose another port.`
    : message;
}
