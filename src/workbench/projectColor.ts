/**
 * IDEA-style project identity: a colour slot (1–9, like RecentProject.ColorN)
 * derived from the project name, and the initials shown in the
 * title bar's project widget.
 */

export const PROJECT_COLOR_COUNT = 9;

/** Stable 1-based colour slot for a project name. */
export function projectColorIndex(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return (Math.abs(h) % PROJECT_COLOR_COUNT) + 1;
}

/**
 * IDEA's AvatarUtils.initials: two camel-case capitals, else the first letters
 * of the first and last words, else one letter. "py-demo" → "PD",
 * "MyProject" → "MP", "idea" → "I".
 */
export function projectInitials(name: string): string {
  const text = name.trim();
  const camel = camelInitials(text);
  if (camel.length === 2) return camel;
  for (const separators of [" ", ",", "-", "_", ".", "`'\""]) {
    const words = text.split(new RegExp(`[${separators}]`)).filter(Boolean);
    if (words.length >= 2) return ([...words[0]!][0]! + [...words.at(-1)!][0]!).toUpperCase();
  }
  return camel || "?";
}

/** First letter plus the next capital of the leading word: "MyProject" → "MP", "idea" → "I". */
function camelInitials(text: string): string {
  const word = /\p{L}[\p{L}\p{N}]*/u.exec(text)?.[0] ?? "";
  const [first, ...rest] = [...word];
  if (!first) return "";
  const capital = rest.find((c) => c !== c.toLowerCase());
  return (first + (capital ?? "")).toUpperCase();
}

/**
 * CSS for slot `n`: `--project-color` (avatar / gradient start) and
 * `--project-color-end`. Theme tokens `--project-color-N(-end)` win when the
 * theme defines them; the fallbacks keep the hues distinct without them.
 */
const FALLBACK: Record<number, [string, string]> = {
  1: ["var(--syn-number)", "var(--danger)"],
  2: ["var(--warning)", "var(--syn-type)"],
  3: ["var(--success)", "var(--vcs-added)"],
  4: ["var(--info)", "var(--link)"],
  5: ["var(--accent)", "var(--syn-annotation)"],
  6: ["var(--danger)", "var(--syn-annotation)"],
  7: ["var(--syn-annotation)", "var(--accent)"],
  8: ["var(--success)", "var(--info)"],
  9: ["var(--vcs-added)", "var(--success)"],
};

export function projectColorVars(name: string): Record<string, string> {
  return projectColorSlotVars(projectColorIndex(name));
}

/** CSS vars for an explicit slot, e.g. a user-chosen tab colour. */
export function projectColorSlotVars(n: number): Record<string, string> {
  const [start, end] = FALLBACK[n]!;
  return {
    "--project-color": `var(--project-color-${n}, ${start})`,
    "--project-color-end": `var(--project-color-${n}-end, ${end})`,
  };
}
