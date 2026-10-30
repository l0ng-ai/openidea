import type { AgentImage } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Dialog } from "@/ui";
import styles from "./ImagePreview.module.css";

export const imageSrc = (img: AgentImage) => `data:${img.mimeType};base64,${img.data}`;

/** The full image in a dialog; `null` keeps it closed. */
export function ImagePreview({ image, onClose }: { image: AgentImage | null; onClose: () => void }) {
  const tx = useTx();
  return (
    <Dialog
      open={image !== null}
      onClose={onClose}
      title={image?.name ?? tx("Image")}
      width="min(90vw, 1000px)"
      buttons={[{ label: tx("Close"), role: "cancel" }]}
    >
      {image && <img className={styles.full} src={imageSrc(image)} alt={image.name ?? tx("Image")} />}
    </Dialog>
  );
}
