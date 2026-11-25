import type { Location } from "@/bindings";
import { tx } from "@/platform/i18n";
import { ask } from "@/workbench/messages";
import styles from "./SafeDeleteUsages.module.css";

type UsagesAnswer = "view" | "delete" | "cancel";

/** `subject`: "Function 'foo'", "File 'a.ts'", "3 files" (`plural`). */
export function usagesMessage(
  subject: string,
  usages: readonly Location[],
  plural = false,
): { message: string; detail: string } {
  const n = usages.length;
  const files = new Set(usages.map((u) => u.path)).size;
  const where = files > 1 ? tx` (in ${files} files)` : "";
  let detail: string;
  if (plural)
    detail =
      n === 1
        ? tx`${subject} have ${n} usage that is not safe to delete${where}.`
        : tx`${subject} have ${n} usages that are not safe to delete${where}.`;
  else
    detail =
      n === 1
        ? tx`${subject} has ${n} usage that is not safe to delete${where}.`
        : tx`${subject} has ${n} usages that are not safe to delete${where}.`;
  return { message: n === 1 ? tx`${n} usage found` : tx`${n} usages found`, detail };
}

export async function askUsagesDetected(
  subject: string,
  usages: readonly Location[],
  plural = false,
): Promise<UsagesAnswer> {
  const { message, detail } = usagesMessage(subject, usages, plural);
  const { button } = await ask({
    title: "Usages Detected",
    presentation: "form",
    width: 540,
    body: (
      <div className={styles.summary}>
        <h2 className={styles.title}>{message}</h2>
        <p className={styles.detail}>{detail}</p>
      </div>
    ),
    buttons: [
      { id: "view", label: "View Usages", primary: true },
      { id: "delete", label: "Delete Anyway" },
    ],
  });
  return button === "view" || button === "delete" ? button : "cancel";
}
