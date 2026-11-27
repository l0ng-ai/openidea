type TuiWindow = Window & { __stopTuiRows?: () => number };

/** Runs in the page; count replacements independently of observer delivery batches. */
export function startTuiRowObserver() {
  const container = document.querySelector(".xterm .xterm-rows");
  if (!container?.childElementCount) throw new Error("terminal row renderer did not open");
  let rebuilt = 0;
  const count = (records: MutationRecord[]) => {
    for (const record of records) if (record.target.parentNode === container) rebuilt++;
  };
  const observer = new MutationObserver(count);
  observer.observe(container, { childList: true, subtree: true });
  (window as TuiWindow).__stopTuiRows = () => {
    count(observer.takeRecords());
    observer.disconnect();
    return rebuilt;
  };
}

export function stopTuiRowObserver(): number {
  const w = window as TuiWindow;
  const stop = w.__stopTuiRows;
  delete w.__stopTuiRows;
  if (!stop) throw new Error("terminal row observer did not start");
  const rebuilt = stop();
  if (!rebuilt) throw new Error("terminal TUI did not render any rows");
  return rebuilt;
}
