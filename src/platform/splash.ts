/**
 * The start-up splash (`#splash` in index.html). It covers the first render and
 * stays up while start-up work holds it (opening the window's launch project),
 * so a project window never flashes the Welcome screen first.
 */
const holds: Promise<unknown>[] = [];
/** Never keep the splash longer than this; a slow open shows its own progress. */
const MAX_WAIT_MS = 4000;
const FILL_MS = 120;

/** Runs the fake progress bar to 100% from wherever its animation has got to; false if nothing shows yet. */
function completeBar(el: HTMLElement): boolean {
  const fill = el.querySelector<HTMLElement>(".splash-bar > i");
  if (!fill || getComputedStyle(el).opacity === "0") return false;
  fill.style.transform = getComputedStyle(fill).transform;
  fill.style.animation = "none";
  void fill.offsetWidth;
  fill.style.transition = `transform ${FILL_MS}ms ease-out`;
  fill.style.transform = "scaleX(1)";
  return true;
}

/** Keeps the splash up until `work` settles. Call before `hideSplash()`. */
export function holdSplash(work: Promise<unknown>): void {
  holds.push(work.catch(() => {}));
}

/** Fades the splash out once every hold has settled and the page has painted. */
export function hideSplash(): void {
  const el = document.getElementById("splash");
  if (!el) return;
  const timeout = new Promise((resolve) => setTimeout(resolve, MAX_WAIT_MS));
  void Promise.race([Promise.all(holds), timeout]).then(() =>
    // Two frames: let React commit the state the holds produced before uncovering it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setTimeout(
          () => {
            if (document.documentElement.dataset.boot === "failed") return;
            el.classList.add("splash-out");
            setTimeout(() => {
              if (document.documentElement.dataset.boot === "failed") return;
              el.remove();
              window.dispatchEvent(new Event("openidea:boot-ready"));
            }, 200);
          },
          completeBar(el) ? FILL_MS : 0,
        );
      }),
    ),
  );
}
