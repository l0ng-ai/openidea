/**
 * Tools › Download sources › Mirror prefix: a plain text field with an info hint, so it is
 * clear that only GitHub downloads go through it (issue #3295).
 */
import { useId } from "react";
import { Icon, Input, T } from "@/ui";
import { Row } from "../components/Form";
import { usePageContext, useSetting } from "../components/context";
import { stage } from "../model/staging";
import styles from "./DownloadSources.module.css";

export function MirrorPrefixRow() {
  const [downloads] = useSetting<{ githubMirror: string }>("toolDownloads", "global");
  const { pageId } = usePageContext();
  const inputId = useId();

  return (
    <Row
      label="Mirror prefix for GitHub downloads"
      htmlFor={inputId}
      hint={
        <span className={styles.hint}>
          <Icon name="info" size={14} className={styles.infoIcon} />
          <T>
            Only downloads from github.com (most language servers and debuggers) are accelerated. Eclipse JDT LS, Open
            VSX and Maven Central are not affected — reach them through System Settings › HTTP Proxy instead. A public
            proxy such as https://gh-proxy.com/ works as the prefix.
          </T>
        </span>
      }
    >
      <Input
        id={inputId}
        className={styles.input}
        placeholder="https://gh-proxy.com/"
        value={downloads.githubMirror}
        onChange={(e) => stage(pageId, "global", "toolDownloads.githubMirror", e.target.value)}
        aria-label="Mirror prefix for GitHub downloads"
      />
    </Row>
  );
}
