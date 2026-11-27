import { useTx } from "@/platform/i18n";
import { Dialog } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { useOverlays } from "../ui/popoverStore";
import { abortTrace } from "./streamState";
import { useStreamTrace } from "./streamStore";

/** "Abort Operation…" asks first: unlike Stop Recording, it throws into the user's program. */
export function StreamAbortDialog() {
  const tx = useTx();
  const session = useOverlays((s) => s.streamAbort);
  // A trace that ended meanwhile has nothing left to abort.
  const running = useStreamTrace((s) => {
    const e = session == null ? undefined : s.bySession[session];
    return !!e && e.result === null && e.error === null;
  });
  const close = () => useOverlays.setState({ streamAbort: null });
  const abort = () => {
    close();
    if (session == null) return;
    abortTrace(session).catch((e: unknown) =>
      notifications().notify({
        group: "run",
        level: "error",
        key: "debug.streamTrace",
        title: tx("Cannot abort the operation"),
        body: e instanceof Error ? e.message : String(e),
      }),
    );
  };
  return (
    <Dialog
      open={session != null && running}
      onClose={close}
      icon="warning"
      title={tx("Abort Operation")}
      // Abort throws into the user's program, so Enter and the initial focus go to Cancel.
      buttons={[
        { label: "Abort", role: "extra", onClick: abort },
        { label: "Cancel", role: "default", onClick: close, autoFocus: true },
      ]}
    >
      {tx("The program will receive java.lang.RuntimeException: oi-cancel. Abort the stream operation?")}
    </Dialog>
  );
}
