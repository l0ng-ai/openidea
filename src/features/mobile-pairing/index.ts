/**
 * Pairing phones with this desktop: a QR code the phone scans, and the paired devices. A
 * paired phone reaches this desktop's backend over iroh (`src-tauri/src/mobile.rs`).
 */
import { registerActions } from "@/platform/actions";
import { registerOverlay } from "@/workbench/contributions";
import { PairHost } from "./PairDialog";
import { openPairDialog } from "./model";

export function activate(): () => void {
  const disposers = [
    registerOverlay({ id: "mobile.pair", component: PairHost }),
    registerActions([
      {
        id: "mobile.pair",
        title: "Pair Mobile Device…",
        description: "Shows a QR code to scan with OpenIDEA on a phone, and the phones paired with this computer.",
        category: "Tools",
        icon: "mobile",
        keywords: ["phone", "mobile", "ios", "android", "pair", "qr", "remote"],
        run: () => openPairDialog(),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
