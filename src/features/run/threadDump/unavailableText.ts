import { tx } from "@/platform/i18n";
import type { JvmMemoryUnavailable, JvmThreadsUnavailable } from "@/platform/ipc";

/** Why no thread dump was taken, as the user reads it. */
export function threadsUnavailableText(reason: JvmThreadsUnavailable): string {
  switch (reason.kind) {
    case "jvm":
      return jvmText(reason.reason);
    case "listenerDidNotStart":
      return tx("The JVM did not accept the request. It may run with -XX:+DisableAttachMechanism.");
    case "remoteRun":
      return tx("Thread dumps are not available for remote runs yet.");
    case "failed": {
      const message = reason.message;
      return tx`Could not dump the threads: ${message}`;
    }
  }
}

function jvmText(reason: JvmMemoryUnavailable): string {
  switch (reason.kind) {
    // Only a stopped JVM answers this: a running one has its listener started for the dump.
    case "listenerNotRunning":
      return tx("Resume the program to dump its threads: the JVM has no attach listener while it is stopped.");
    case "unsafeWhileSuspended": {
      const n = reason.javaMajor;
      return n > 0
        ? tx`Resume the program to dump its threads: Java ${n} cannot answer while the debugger stops it.`
        : tx("Resume the program to dump its threads: this Java version cannot answer while the debugger stops it.");
    }
    case "noJvmProcess":
      return tx("No Java process was found for this run.");
    case "programExited":
      return tx("The program has exited.");
    case "unsupportedPlatform":
      return tx("Thread dumps are not available on this platform yet.");
    case "timedOut":
      return tx("The JVM did not answer in time.");
    case "attachedJvmNotFound":
      return tx("Could not find the debugged JVM on this computer.");
    case "listenModeNotSupported":
      return tx("Thread dumps are not available when the IDE listens for the JVM to connect.");
  }
}
