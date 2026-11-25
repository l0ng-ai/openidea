import { useRunningActions } from "@/platform/actions";
import { useContextKeys } from "@/platform/context";
import { IconButton } from "@/ui";

export function FetchButton() {
  const fetching = useRunningActions((s) => s.running.has("vcs.fetch"));
  const disabled = useContextKeys((s) => !!s.vcsFetchDisabled);
  return (
    <IconButton
      icon="git-fetch"
      title={fetching ? "Fetching…" : "Fetch"}
      size="small"
      action="vcs.fetch"
      disabled={disabled && !fetching}
    />
  );
}
