// The console driver (console.py) prints ordinary output as it is and its own messages
// as `\x1e<json>\n` lines on stdout.

export type ConsoleVariable = { name: string; type: string; value: string };
export type ConsoleMessage =
  | { ready: { version: string; ipython: string | null } }
  | { done: { variables: ConsoleVariable[] } };

const RS = "\x1e";

/** Splits stdout into the text to show and the driver's messages; a message cut across chunks waits for the rest. */
export function stdoutParser() {
  let pending = "";
  return (chunk: string): { text: string; messages: ConsoleMessage[] } => {
    let rest = pending + chunk;
    pending = "";
    let text = "";
    const messages: ConsoleMessage[] = [];
    for (;;) {
      const first = rest.indexOf(RS);
      if (first < 0) break;
      const end = rest.indexOf("\n", first);
      if (end < 0) {
        pending = rest.slice(first);
        rest = rest.slice(0, first);
        break;
      }
      // A message starts a line's last \x1e: an earlier one there is output that didn't end its line.
      const start = rest.lastIndexOf(RS, end);
      text += rest.slice(0, start);
      try {
        messages.push(JSON.parse(rest.slice(start + 1, end)) as ConsoleMessage);
      } catch {
        text += rest.slice(start, end + 1);
      }
      rest = rest.slice(end + 1);
    }
    return { text: text + rest, messages };
  };
}

/** The stdin line that asks the driver to run `code`. */
export const request = (code: string) => `${JSON.stringify({ code })}\n`;
