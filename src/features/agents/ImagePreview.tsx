import type { AgentImage } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { useEffect, useState } from "react";
import { executeAction } from "@/platform/actions";
import { Dialog, showContextMenu } from "@/ui";
import { copyImageAction, imageSrc, type CopyImage } from "./imageActions";
import styles from "./ImagePreview.module.css";

/** The full image in a dialog; `null` keeps it closed. */
export function ImagePreview({ image, onClose }: { image: AgentImage | null; onClose: () => void }) {
  const tx = useTx();
  const [copied, setCopied] = useState<AgentImage | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const target: CopyImage | null = image ? { image, onCopied: () => setCopied(image) } : null;
  return (
    <Dialog
      open={image !== null}
      onClose={onClose}
      title={image?.name ?? tx("Image")}
      width="min(90vw, 1000px)"
      buttons={[
        {
          label: tx(image && copied === image ? "Copied" : "Copy Image"),
          disabled: !target,
          onClick: () => target && void executeAction(copyImageAction.id, target),
        },
        { label: tx("Close"), role: "cancel" },
      ]}
    >
      {image && (
        <img
          className={styles.full}
          src={imageSrc(image)}
          alt={image.name ?? tx("Image")}
          onContextMenu={(event) => {
            event.stopPropagation();
            showContextMenu(event, [{ kind: "action", action: copyImageAction.id, arg: target }]);
          }}
        />
      )}
    </Dialog>
  );
}
