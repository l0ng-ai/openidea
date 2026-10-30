/**
 * The row's hover balloons (`ReviewListCellRenderer.LazyIdeToolTip`): after the tooltip
 * delay, a balloon to the right of the labels icon or an avatar stack, titled with the
 * collection's name ("Labels", "Reviewers") over a list of icon + text rows. It stays
 * open while the pointer is over the trigger or the balloon.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popup, TOOLTIP_DELAY } from "@/ui";
import styles from "./List.module.css";

export interface BalloonItem {
  key: string;
  icon: ReactNode;
  text: string;
}

const HIDE_GRACE_MS = 120;

export function HoverBalloon({
  title,
  items,
  children,
  className,
}: {
  title: string;
  items: readonly BalloonItem[];
  children: ReactNode;
  className?: string;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const later = (next: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), ms);
  };
  const enter = () => (open ? clearTimeout(timer.current) : later(true, TOOLTIP_DELAY));
  const leave = () => (open ? later(false, HIDE_GRACE_MS) : clearTimeout(timer.current));
  return (
    <>
      <span
        ref={anchor}
        className={className}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onPointerDown={() => {
          clearTimeout(timer.current);
          setOpen(false);
        }}
      >
        {children}
      </span>
      <Popup
        open={open}
        anchor={anchor}
        placement="right"
        offset={6}
        role="tooltip"
        autoFocus={false}
        restoreFocus={false}
        onClose={() => setOpen(false)}
        className={styles.balloon}
      >
        <div onPointerEnter={enter} onPointerLeave={leave}>
          <div className={styles.balloonTitle}>{title}</div>
          {items.map((item) => (
            <div key={item.key} className={styles.balloonRow}>
              {item.icon}
              <span>{item.text}</span>
            </div>
          ))}
        </div>
      </Popup>
    </>
  );
}
