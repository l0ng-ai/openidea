/** Test Connection of Settings › Tools › SSH Configurations: what a failure asks of the user. */
import type { SshAuthValid } from "@/platform/remoteSettings";

export type SshTestRemedy = "trustHostKey" | "secret" | null;

/**
 * An unknown host key to confirm, or a missing / rejected password or key
 * passphrase to type. A changed host key is never offered for trust.
 */
export function sshTestRemedy(kind: string | undefined, message: string, auth: SshAuthValid): SshTestRemedy {
  if (/^Unknown SSH host key/.test(message)) return "trustHostKey";
  if (kind !== "permissionDenied") return null;
  if (/^SSH host key .* has changed/.test(message)) return null;
  if (/^SSH (password|key passphrase) required|^cannot decrypt SSH key/.test(message)) return "secret";
  // With OpenSSH config + agent there is nothing to type unless a key is encrypted.
  if (/^SSH authentication failed/.test(message)) return auth === "openSsh" ? null : "secret";
  return null;
}

/** "Password" or "Passphrase", from the configuration and the prompt. */
export function secretKind(auth: SshAuthValid, message = ""): "password" | "passphrase" {
  if (/passphrase|decrypt/.test(message)) return "passphrase";
  if (/password/.test(message)) return "password";
  return auth === "password" ? "password" : "passphrase";
}

/** A port typed in the Port field (empty or invalid: the default). */
export function parseSshPort(text: string): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = parseInt(text, 10);
  return n > 0 && n <= 65535 ? n : null;
}
