import { useActions } from "@/platform/actions";
/** Plugin action slots in existing editor and main toolbars. */
import { useContextKeys, evaluateWhen } from "@/platform/context";
import { IconButton } from "@/ui";
import { useMenuSlotItems } from "./contributions";
export function ContributedToolbar({ slot }: { slot: string }) {
  const actions = useActions((s) => s.actions);
  const items = useMenuSlotItems((s) => s.slots[slot]);
  useContextKeys();
  return (
    <>
      {(items ?? [])
        .filter((i) => evaluateWhen(i.when ?? undefined))
        .map((i) => (
          <IconButton
            key={i.action}
            icon={actions.get(i.action)?.icon ?? i.icon ?? "plugin"}
            action={i.action}
            actionArg={i.arg}
            title={i.label}
            size="small"
          />
        ))}
    </>
  );
}
