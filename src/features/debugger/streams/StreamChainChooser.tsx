import clsx from "clsx";
import type { ChainUnavailable } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Dialog, Icon, List } from "@/ui";
import { useOverlays } from "../ui/popoverStore";
import { pickStreamChain } from "./streamState";
import styles from "./StreamChainChooser.module.css";

function unavailableText(reason: ChainUnavailable): string {
  switch (reason.kind) {
    case "notTopFrame":
      return tx("Select the top frame to trace a stream chain");
    case "notAtChainStart":
      return tx("Stop at the first line of the chain to trace its real run");
    case "insideChainLambda":
      return tx("The chain is already running");
    case "notJavaStreamRoot":
      return tx("The stream does not start in this statement");
    case "lazyTerminal":
      return tx("iterator() and spliterator() do not run the pipeline");
    case "noTerminal":
      return tx("The chain has no terminal operation");
    case "unknownOperation":
      return tx("Unknown stream operation");
    case "syntaxError":
      return tx("The statement does not parse");
    case "noBackend":
      return tx("Stream tracing needs the Java debugger's inspector");
  }
}

/** Trace Stream Chain's chooser; a chain that cannot be traced stays listed, with why, but does not activate. */
export function StreamChainChooser() {
  const state = useOverlays((s) => s.streamChooser);
  const close = () => useOverlays.setState({ streamChooser: null });
  const chains = state?.chains ?? [];
  return (
    <Dialog
      open={!!state}
      onClose={close}
      title="Choose Stream Chain"
      width={560}
      position="top"
      aria-label="Choose Stream Chain"
    >
      <List
        items={chains}
        getKey={(c) => String(c.index)}
        defaultActiveIndex={Math.max(
          0,
          chains.findIndex((c) => !c.reason),
        )}
        onActivate={(chain) => void pickStreamChain(chain)}
        aria-label={tx("Stream chains on the current line")}
        className={styles.list}
        renderItem={(c) => (
          <div className={clsx(styles.row, c.reason && styles.unavailable)} aria-disabled={c.reason ? true : undefined}>
            <Icon name="stream-trace" size={14} />
            <span className={styles.text}>{c.text.replace(/\s+/g, " ")}</span>
            {c.reason && <span className={styles.reason}>{unavailableText(c.reason)}</span>}
          </div>
        )}
      />
    </Dialog>
  );
}
