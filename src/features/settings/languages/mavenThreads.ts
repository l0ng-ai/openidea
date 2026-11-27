/**
 * Whether Maven accepts `value` as `-T`: a thread count (`4`) or a core multiplier with an
 * optional decimal fraction (`1C`, `2.5C`). Mirrors `MavenSettings::thread_count`, which
 * leaves any other value out of the command line.
 */
export function isMavenThreadCount(value: string): boolean {
  return /^(?:\d+(?:\.\d+)?)C?$/.test(value.trim()) && parseFloat(value) > 0;
}
