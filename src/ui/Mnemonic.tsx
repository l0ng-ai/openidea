import { usePlatform } from "@/platform/platformInfo";

/** Where the mnemonic letter sits in `text`: an upper-case match first ("Replace &All"), else any. */
export function mnemonicIndex(text: string, char: string): number {
  const upper = text.indexOf(char.toUpperCase());
  return upper >= 0 ? upper : text.toLowerCase().indexOf(char.toLowerCase());
}

/**
 * A control label with its Alt+letter mnemonic as IDEA draws it on Windows and Linux:
 * the letter underlined, or `(X)` added to text without it (CJK translations).
 * macOS has no mnemonics. `text` is already translated.
 */
export function Mnemonic({ text, char }: { text: string; char: string }) {
  const mac = usePlatform((p) => p.os === "macos");
  if (mac) return text;
  const at = mnemonicIndex(text, char);
  if (at >= 0)
    return (
      <>
        {text.slice(0, at)}
        <u>{text[at]}</u>
        {text.slice(at + 1)}
      </>
    );
  // "文件掩码：" → "文件掩码 (K)："
  const colon = /[:：]$/.exec(text)?.[0] ?? "";
  return (
    <>
      {text.slice(0, text.length - colon.length)} (<u>{char.toUpperCase()}</u>){colon}
    </>
  );
}
