import { executeAction } from "./actions";
import { tx } from "./i18n";
import { downloadJdkActions } from "./jdk";

/** Recovery shared by build sync, run configurations and language-server import errors. */
export function buildToolRecovery(message: string) {
  if (message.startsWith("tsserver stopped because it reached its memory limit")) {
    const settings = {
      label: tx("Language Servers…"),
      run: () => void executeAction("file.settings", "languages.servers"),
    };
    return { body: message, actions: [settings] };
  }
  const actions = downloadJdkActions(message);
  const incompatible = /Can't use Java .* and Gradle .* to import Gradle project/i.test(message);
  const missing = /command not found: ([^\r\n]+)|cannot start ([^\r\n]+?): [^\r\n]*\(os error [23]\)/i.exec(message);
  const command = (missing?.[1] ?? missing?.[2] ?? "").trim().replace(/^["'`]|["'`]$/g, "");
  const namedTool = /(?:^|[/\\])(?:mvn|mvnw|mvnd)(?:\.(?:cmd|bat|exe))?$/i.test(command)
    ? "maven"
    : /(?:^|[/\\])gradlew?(?:\.(?:bat|exe))?$/i.test(command)
      ? "gradle"
      : undefined;
  const recoveryTool = incompatible ? "gradle" : namedTool;
  if (!recoveryTool) return { body: message, actions };
  const label =
    recoveryTool === "maven"
      ? tx("Open Maven Settings")
      : incompatible
        ? tx("Choose Gradle JVM")
        : tx("Open Gradle Settings");
  actions.push({ label, run: () => void executeAction("file.settings", `build.${recoveryTool}`) });
  const hint = incompatible
    ? tx(
        "Choose a JDK compatible with this Gradle version in Gradle JVM. Download JDK is available in the JVM selector.",
      )
    : recoveryTool === "maven"
      ? tx(
          "Maven could not be started. Configure Maven home in Maven settings, install Maven on PATH, or use a project with a Maven wrapper.",
        )
      : tx(
          "Gradle could not be started. Configure a local installation in Gradle settings, install Gradle on PATH, or use a project with a Gradle wrapper.",
        );
  return { body: `${hint}\n\n${message}`, actions };
}
