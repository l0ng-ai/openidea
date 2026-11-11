import { tx } from "@/platform/i18n";
import type { JvmMemoryUnavailable } from "@/platform/ipc";

/** Why the class table could not be read. */
export function unavailableText(reason: JvmMemoryUnavailable): string {
  switch (reason.kind) {
    case "attachedJvmNotFound":
      return tx(
        "Memory view needs a JVM on this computer started with -XX:+StartAttachListener. Programs the IDE debugs get it automatically.",
      );
    case "listenModeNotSupported":
      return tx("Memory view is not available when the IDE listens for the JVM to connect.");
    case "unsupportedPlatform":
      return tx("Memory view is not available on this platform yet.");
    case "noJvmProcess":
      return tx("Could not find the program's JVM process.");
    case "listenerNotRunning":
      return tx(
        "The JVM does not accept attach requests. Restart the debug session without -XX:+DisableAttachMechanism.",
      );
    case "unsafeWhileSuspended": {
      const v = reason.javaMajor;
      return v > 0
        ? tx`JDK ${v} cannot report memory while suspended. Resume the program, then refresh.`
        : tx("This JDK cannot report memory while suspended. Resume the program, then refresh.");
    }
    case "programExited":
      return tx("The program has exited.");
    case "timedOut":
      return tx("The JVM did not answer within 10 seconds.");
  }
}
