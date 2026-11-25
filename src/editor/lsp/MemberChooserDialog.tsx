import { useState } from "react";
import { Checkbox, Dialog, Icon, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import { useMemberChooser, type MemberChooserRequest } from "./memberChooser";
import styles from "./MemberChooserDialog.module.css";

export function MemberChooserDialog() {
  const request = useMemberChooser((s) => s.request);
  if (!request) return null;
  return <MemberChooserInner key={request.seq} request={request} />;
}

function MemberChooserInner({ request }: { request: MemberChooserRequest }) {
  const tx = useTx();
  const { members } = request;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const allChecked = checked.size === members.length;

  const finish = (ids: string[] | null) => {
    if (useMemberChooser.getState().request === request) useMemberChooser.setState({ request: null });
    request.resolve(ids);
    request.view.focus();
  };
  const toggle = (id: string, on: boolean) =>
    setChecked((all) => {
      const next = new Set(all);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Dialog
      open
      onClose={() => finish(null)}
      title={request.title}
      className={styles.dialog}
      width={520}
      minWidth={320}
      minHeight={300}
      resizable="both"
      buttons={[
        {
          label: "OK",
          role: "default",
          disabled: !checked.size,
          onClick: () => finish(members.map((m) => m.id).filter((id) => checked.has(id))),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.body}>
        <div className={styles.table} role="table" aria-label={tx(request.title)}>
          <div className={styles.head} role="row">
            <div role="columnheader">
              <Checkbox
                className={styles.member}
                checked={allChecked}
                indeterminate={checked.size > 0 && !allChecked}
                onChange={(on) => setChecked(on ? new Set(members.map((m) => m.id)) : new Set())}
                aria-label="Select All"
                label={<T>Member</T>}
              />
            </div>
          </div>
          {members.map((m, i) => (
            <div key={m.id} role="rowgroup">
              {m.group && m.group !== members[i - 1]?.group && (
                <div className={styles.group} role="row">
                  <span role="cell">
                    <Icon name="class" size={16} />
                    {m.group}
                  </span>
                </div>
              )}
              <div className={styles.row} role="row" data-grouped={m.group ? "" : undefined}>
                <div role="cell">
                  <Checkbox
                    className={styles.member}
                    checked={checked.has(m.id)}
                    onChange={(on) => toggle(m.id, on)}
                    label={
                      <span className={styles.memberLabel} title={m.label + (m.detail ?? "")}>
                        <Icon name={m.icon} size={16} />
                        <span className={styles.label}>
                          {m.label}
                          {m.detail && <span className={styles.detail}>{m.detail}</span>}
                        </span>
                      </span>
                    }
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
