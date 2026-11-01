import { useTx } from "@/platform/i18n";
import { Button, Icon, Spinner, tooltipAttrs, type ButtonProps } from "@/ui";
import styles from "./SubmitButton.module.css";

export function SubmitButton({
  label,
  pending = false,
  variant = "primary",
  ...props
}: Pick<ButtonProps, "disabled" | "onClick" | "variant"> & {
  label: "Start" | "Starting…" | "Send" | "Queue";
  pending?: boolean;
}) {
  const tx = useTx();
  const name = tx(label);
  return (
    <Button
      {...props}
      variant={variant}
      size="small"
      className={styles.submit}
      aria-label={name}
      {...tooltipAttrs(name)}
    >
      {pending ? <Spinner size={12} /> : <Icon name="arrow-up" size={14} />}
    </Button>
  );
}
