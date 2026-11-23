/**
 * Binary command arguments (`IpcBytes` in Rust) cross IPC as base64 text: as a JSON number array
 * they take 3.6x the size and a parsed `Value` tree of roughly 50x.
 */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  // `apply` with a typed array is about 5x faster than spreading it (20 MB: 70 ms vs 380 ms).
  for (let i = 0; i < bytes.length; i += 0x8000)
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]));
  return btoa(parts.join(""));
}
