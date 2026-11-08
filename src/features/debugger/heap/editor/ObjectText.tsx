import type { HeapObjectRow } from "@/platform/ipc";
import { objectName } from "./classRows";
import styles from "../HeapSnapshotEditor.module.css";

const STRING = "java.lang.String";

/**
 * `className@address`, then the text of a string in quotes, or, for a class object, the class it stands for (a name,
 * so no quotes).
 */
export function ObjectText({ object }: { object: HeapObjectRow }) {
  const { preview } = object;
  const quoted = object.className === STRING;
  return (
    <span className={styles.object}>
      <span className={styles.objectName}>{objectName(object)}</span>
      {preview !== null && (
        <span className={quoted ? styles.stringPreview : styles.preview}>{quoted ? `"${preview}"` : preview}</span>
      )}
    </span>
  );
}
