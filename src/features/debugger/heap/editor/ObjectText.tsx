import { tooltipAttrs } from "@/ui";
import type { HeapObjectRow } from "@/platform/ipc";
import { objectName } from "./classRows";
import styles from "../HeapSnapshotEditor.module.css";

const STRING = "java.lang.String";

/**
 * `className@address`, then the text of a string in quotes, or, for a class object, the class it stands for (a name,
 * so no quotes). A narrow column cuts it off with an ellipsis; the tooltip has the whole text.
 */
export function ObjectText({ object }: { object: HeapObjectRow }) {
  const { preview } = object;
  const name = objectName(object);
  const shown = preview === null ? null : object.className === STRING ? `"${preview}"` : preview;
  return (
    <span className={styles.object} {...tooltipAttrs(shown === null ? name : `${name} ${shown}`, undefined, true)}>
      <span className={styles.objectName}>{name}</span>
      {shown !== null && (
        <span className={object.className === STRING ? styles.stringPreview : styles.preview}>{shown}</span>
      )}
    </span>
  );
}
