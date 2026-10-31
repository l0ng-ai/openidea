import * as stylex from "@stylexjs/stylex";
import { publicAsset } from "../lib/paths.mjs";
import { useDownloadPath } from "./useDownloadPath";
import { styles as s } from "./home.stylex";

export const repository = "https://github.com/l0ng-ai/openidea";
export const docs = `${repository}#build`;

export function SiteHeader() {
  const downloadPath = useDownloadPath();
  return (
    <>
      <a {...stylex.props(s.skipLink)} href="#main">
        Skip to content
      </a>
      <header {...stylex.props(s.wide, s.header)}>
        <a {...stylex.props(s.brand)} href={import.meta.env.BASE_URL} aria-label="OpenIDEA home">
          <img
            {...stylex.props(s.mark)}
            src={publicAsset("mark.svg", import.meta.env.BASE_URL)}
            width={39}
            height={39}
            alt=""
          />
          OpenIDEA
        </a>
        <nav {...stylex.props(s.nav)} aria-label="Main navigation">
          <a {...stylex.props(s.navLink)} href={docs}>
            Docs
          </a>
          <a {...stylex.props(s.navLink)} href={repository}>
            GitHub
          </a>
          <a {...stylex.props(s.navLink, s.navDownload)} href={downloadPath}>
            Download
          </a>
        </nav>
      </header>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer {...stylex.props(s.wide, s.footer)}>
      <div {...stylex.props(s.footerMain)}>
        <span>OpenIDEA</span>
        <div {...stylex.props(s.footerLinks)}>
          <a href={`${repository}/releases`}>Releases</a>
          <a href={repository}>GitHub</a>
          <a href={`${repository}/blob/main/LICENSE`}>Apache 2.0</a>
        </div>
      </div>
      <p {...stylex.props(s.trademark)}>
        Not affiliated with JetBrains. IntelliJ IDEA is a trademark of JetBrains s.r.o.
      </p>
    </footer>
  );
}
