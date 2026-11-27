/**
 * PyCharm's Plots tool window (SciView): matplotlib figures of Python runs, debug sessions and the
 * Python Console, the selected one in the image viewer (zoom, fit, 1:1) beside a column of thumbnails.
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { IconButton, T } from "@/ui";
import { ImageViewer } from "@/features/viewers/ImageViewer";
import { clearPlots, copyPlot, removePlot, savePlot, usePlots } from "./store";
import styles from "./Plots.module.css";

function Thumbnail({ path, index, selected }: { path: string; index: number; selected: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    call(commands.fsReadImage(path))
      .then((url) => current && setSrc(url))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [path]);
  const n = index + 1;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-label={tx`Plot ${n}`}
      className={clsx(styles.thumbnail, selected && styles.selected)}
      onClick={() => usePlots.setState({ selected: path })}
    >
      {src && <img src={src} alt="" draggable={false} />}
    </button>
  );
}

export function PlotsView() {
  const plots = usePlots((s) => s.plots);
  const selected = usePlots((s) => s.selected);
  if (!plots.length)
    return (
      <div className={styles.empty}>
        <T>Figures that Python code shows with plt.show() appear here.</T>
      </div>
    );
  return (
    <div className={styles.root}>
      <div className={styles.viewer}>
        {selected && <ImageViewer key={selected} input={{ kind: "plot", key: selected, path: selected }} />}
      </div>
      <div className={styles.thumbnails} role="listbox" aria-label={tx("Plots")}>
        {plots.map((path, i) => (
          <Thumbnail key={path} path={path} index={i} selected={path === selected} />
        ))}
      </div>
    </div>
  );
}

export function PlotsHeaderActions() {
  const selected = usePlots((s) => s.selected);
  const any = usePlots((s) => s.plots.length > 0);
  return (
    <>
      <IconButton
        icon="download"
        size="small"
        title="Save as PNG"
        disabled={!selected}
        onClick={() => selected && void savePlot(selected)}
      />
      <IconButton
        icon="copy"
        size="small"
        title="Copy to Clipboard"
        disabled={!selected}
        onClick={() => selected && copyPlot(selected)}
      />
      <IconButton
        icon="close"
        size="small"
        title="Delete Plot"
        disabled={!selected}
        onClick={() => selected && removePlot(selected)}
      />
      <IconButton icon="trash" size="small" title="Delete All Plots" disabled={!any} onClick={clearPlots} />
    </>
  );
}
