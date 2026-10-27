import { useEffect, useState } from "react";
import { create } from "zustand";
import { executeAction } from "@/platform/actions";
import { t as translate, useT } from "@/platform/i18n";
import { commands, isTauri, type AppInfo, type BuildInfo } from "@/platform/ipc";
import clsx from "clsx";
import { Dialog, IconButton, selectableText } from "@/ui";
import logo from "../../../src-tauri/icons/128x128.png";
import { buildInfo, guessOs } from "./host";
import styles from "./app.module.css";

export const useAbout = create<{ open: boolean }>(() => ({ open: false }));

export const showAbout = () => useAbout.setState({ open: true });

function osName(os: string): string {
  const key = `os.${os}`;
  const v = translate(key);
  return v === key ? os : v;
}

export function aboutRows(b: BuildInfo | null, configDir: string | null): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (b) {
    rows.push([translate("app.about.version"), b.version]);
    rows.push([translate("app.about.build"), `${b.build} (${b.profile})`]);
    rows.push([translate("app.about.platform"), `${osName(b.os)} ${b.arch}`]);
    rows.push([translate("app.about.runtime"), `Tauri ${b.tauri}`]);
  } else {
    rows.push([translate("app.about.platform"), osName(guessOs())]);
  }
  if (configDir) rows.push([translate("app.about.configDir"), configDir]);
  return rows;
}

export function AboutOverlay() {
  const open = useAbout((s) => s.open);
  if (!open) return null;
  return <AboutDialog onClose={() => useAbout.setState({ open: false })} />;
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [app, setApp] = useState<AppInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    void buildInfo().then((b) => live && setBuild(b));
    if (isTauri())
      void commands
        .appInfo()
        .then((a) => live && setApp(a))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const rows = aboutRows(build, app?.configDir ?? null);
  const copy = () => {
    const text = [t("app.about.title"), ...rows.map(([k, v]) => `${k}: ${v}`)].join("\n");
    void navigator.clipboard?.writeText(text).then(() => setCopied(true));
  };
  const run = (id: string) => {
    onClose();
    void executeAction(id);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      aria-label={t("app.about.title")}
      width={520}
      footerStart={
        <IconButton
          icon={copied ? "check" : "copy"}
          title={copied ? t("common.copied") : t("app.about.copyInfo")}
          onClick={copy}
        />
      }
      buttons={[{ label: t("common.close"), role: "default", onClick: onClose, autoFocus: true }]}
    >
      <div className={styles.about}>
        <img className={styles.logo} src={logo} alt="" width={64} height={64} />
        <div className={styles.aboutBody}>
          <div className={clsx(styles.productName, selectableText)}>OpenIDEA {build?.version ?? ""}</div>
          {build && (
            <div className={clsx(styles.aboutLine, selectableText)}>
              {t("app.about.build")} #{build.build} ({build.profile})
            </div>
          )}
          <div className={clsx(styles.tagline, selectableText)}>{t("app.about.tagline")}</div>
          <dl className={styles.facts}>
            {rows
              .filter(([k]) => k !== t("app.about.version") && k !== t("app.about.build"))
              .map(([k, v]) => (
                <div key={k} className={styles.fact}>
                  <dt>{k}:</dt>
                  <dd title={v}>{v}</dd>
                </div>
              ))}
          </dl>
          <div className={styles.links}>
            <button type="button" className={styles.link} onClick={() => run("help.keymapReference")}>
              {t("app.action.keymapReference")}
            </button>
            <button type="button" className={styles.link} onClick={() => run("help.showLog")}>
              {t("app.action.showLog", { os: build?.os ?? guessOs() })}
            </button>
            {app && (
              <button
                type="button"
                className={styles.link}
                onClick={() => void import("@tauri-apps/plugin-opener").then((o) => o.revealItemInDir(app.configDir))}
              >
                {t("app.about.showConfig")}
              </button>
            )}
          </div>
          <div className={clsx(styles.license, selectableText)}>
            {t("app.about.copyright")}
            <br />
            {t("app.about.license")}
          </div>
          <div className={clsx(styles.disclaimer, selectableText)}>
            {t("app.about.thirdParty")} {t("app.about.disclaimer")}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
