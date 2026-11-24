import { useState } from "react";
import type { AgentImage } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { IconButton } from "@/ui";
import { ImagePreview, imageSrc } from "./ImagePreview";
import styles from "./Session.module.css";

/** Image thumbnails; a click opens the full image, `onRemove` adds a remove button to each. */
export function ImageStrip({ images, onRemove }: { images: AgentImage[]; onRemove?: (index: number) => void }) {
  const tx = useTx();
  const [open, setOpen] = useState<AgentImage | null>(null);
  if (images.length === 0) return null;
  return (
    <div className={styles.images}>
      {images.map((img, i) => (
        <span
          // oxlint-disable-next-line react/no-array-index-key -- identical images can repeat; position is the identity
          key={i}
          className={styles.imageItem}
        >
          <button
            type="button"
            className={styles.imageButton}
            title={img.name ?? undefined}
            onClick={() => setOpen(img)}
          >
            <img className={styles.image} src={imageSrc(img)} alt={img.name ?? tx("Image")} />
          </button>
          {onRemove && (
            <IconButton
              type="button"
              className={styles.removeImage}
              aria-label={tx("Remove Image")}
              onClick={() => onRemove(i)}
              icon="close"
              size="small"
            />
          )}
        </span>
      ))}
      <ImagePreview image={open} onClose={() => setOpen(null)} />
    </div>
  );
}
