import { useEffect, useRef } from "react";
import { BarButton, Icon, Menu, type MenuItem } from "@/ui";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import {
  currentFlutterDevice,
  isFlutterConfig,
  matchFlutterDevice,
  pinnedFlutterDevice,
  useFlutterDevices,
  usableFlutterDevices,
  watchFlutterDevices,
} from "@/workbench/flutterDevices";
import { useRun } from "./store";
import styles from "./Run.module.css";

/** Title bar: the device Flutter launches use, in projects with a Flutter configuration. */
export function FlutterDeviceChooser() {
  const flutter = useRun((s) => s.configs.some(isFlutterConfig));
  const root = useProject((s) => s.project?.root);
  return flutter && root ? <Chooser root={root} /> : null;
}

function Chooser({ root }: { root: string }) {
  const tx = useTx();
  const anchor = useRef<HTMLButtonElement>(null);
  const state = useFlutterDevices();
  const selected = useRun((s) => s.configs.find((c) => c.id === s.selectedId));
  useEffect(() => watchFlutterDevices(root), [root]);

  const { list, chooserOpen } = state;
  const status = list?.status;
  const usable = usableFlutterDevices(list);
  const current = currentFlutterDevice(state);
  const pinned = selected && isFlutterConfig(selected) ? pinnedFlutterDevice(selected) : null;
  const pinnedDevice = pinned ? matchFlutterDevice(pinned, usable) : null;
  const problem =
    status?.kind === "notInstalled" ||
    status?.kind === "failed" ||
    (!!pinned && status?.kind === "ready" && pinned !== "all" && !pinnedDevice);

  const label = pinned
    ? (pinnedDevice?.name ?? pinned)
    : status?.kind === "notInstalled"
      ? tx("Flutter SDK not found")
      : status?.kind === "failed"
        ? tx("Flutter devices unavailable")
        : (current?.name ?? (status?.kind === "ready" ? tx("No devices") : tx("Finding devices…")));

  const items: MenuItem[] = [
    ...(pinned ? [{ kind: "header", label: tx`Pinned by “${selected?.name ?? ""}”` } as const] : []),
    ...(list?.devices ?? []).map((d): MenuItem => ({
      id: d.id,
      label: d.unavailable ? `${d.name} (${d.unavailable})` : d.name,
      verbatim: true,
      checked: !pinned && d.id === current?.id,
      disabled: !!pinned || !!d.unavailable,
      run: () => void executeAction("run.flutterSelectDevice", d.id),
    })),
    ...(status?.kind === "ready" && !list?.devices.length
      ? [{ label: tx("No devices connected"), disabled: true }]
      : []),
    ...(status?.kind === "notInstalled"
      ? [{ label: tx("Install Flutter or add it to PATH, then restart the daemon"), disabled: true }]
      : []),
    ...(status?.kind === "failed" ? [{ label: status.message, verbatim: true, disabled: true }] : []),
    { kind: "separator" },
    { kind: "action", action: "run.flutterRestartDaemon" },
  ];

  return (
    <>
      <BarButton
        ref={anchor}
        variant="title"
        className={styles.widgetDevice}
        data-toolbar-icon-dropdown=""
        tooltip={pinned ? tx`Flutter device, pinned by “${selected?.name ?? ""}”` : tx("Flutter Device")}
        aria-label={tx`Flutter device: ${label}`}
        aria-haspopup="menu"
        aria-expanded={chooserOpen}
        onClick={() => void executeAction("run.flutterChooseDevice")}
      >
        <Icon name={problem ? "warning" : "project-flutter"} size={16} />
        <span className={styles.widgetName} data-toolbar-label="">
          {label}
        </span>
        <Icon name="chevron-down" size={14} className={styles.widgetChevron} />
      </BarButton>
      <Menu
        open={chooserOpen}
        anchor={anchor}
        items={items}
        placement="bottom-end"
        onClose={() => useFlutterDevices.setState({ chooserOpen: false })}
      />
    </>
  );
}
