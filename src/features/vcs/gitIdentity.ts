import { call, commands } from "@/platform/ipc";

export async function readConfiguredGitIdentity(root: string | null) {
  const get = (key: string) =>
    call(commands.vcsConfigGet(root, key)).then(
      (value) => value?.trim() || null,
      () => null,
    );
  const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
  return { name, email };
}

/** Identifies the person by name, falling back to the email's local part. */
export function gitPersonKey(name: string | null | undefined, email?: string | null): string {
  const at = email?.indexOf("@") ?? -1;
  const person = name || (at > 0 ? email?.slice(0, at) : email) || "";
  if (/[^\x20-\x7e]/.test(person)) return person;
  return person.toLowerCase().replace(/^(\w+)[\s\p{P}\p{S}](\w+)$/u, "$1 $2");
}
