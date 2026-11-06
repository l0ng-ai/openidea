import * as stylex from "@stylexjs/stylex";
import manifest from "../data/release.json";
import type { Platform } from "../lib/downloads.mjs";
import { publicAsset } from "../lib/paths.mjs";
import { SiteHeader, SiteFooter, docs } from "./SiteLayout";
import { styles as shared } from "./home.stylex";
import { styles as s } from "./download.stylex";

const platforms = [
  {
    id: "macos",
    name: "macOS",
    detail: "Apple Silicon and Intel Macs.",
    instruction: "Open the DMG and drag OpenIDEA into Applications. Requires macOS 11 or later.",
  },
  {
    id: "windows",
    name: "Windows",
    detail: "64-bit Intel and AMD PCs.",
    instruction:
      "Download the EXE and follow the setup steps. The MSI package is also available for managed installations.",
  },
  {
    id: "linux",
    name: "Linux",
    detail: "AppImage, DEB and RPM for x86_64.",
    instruction:
      "Make the AppImage executable, then open it. For Debian or Ubuntu, use the DEB package; for Fedora or RHEL, use the RPM package. This release contains x86_64 Linux packages.",
  },
] as const;

function DownloadIntro({ title }: { title: string }) {
  return (
    <div {...stylex.props(s.intro)}>
      <img
        {...stylex.props(s.logo)}
        src={publicAsset("mark.svg", import.meta.env.BASE_URL)}
        width={64}
        height={64}
        alt=""
      />
      <h1 {...stylex.props(s.title)}>{title}</h1>
      <div {...stylex.props(s.version)}>
        <span>Version {manifest.version}</span>
        <a {...stylex.props(s.notes)} href={manifest.releaseUrl}>
          Release notes
        </a>
      </div>
    </div>
  );
}

export function DownloadsPage() {
  return (
    <>
      <SiteHeader />
      <main {...stylex.props(s.main, shared.wide)} id="main">
        <DownloadIntro title="Download OpenIDEA" />
        <p {...stylex.props(s.indexCopy)}>Choose your desktop platform.</p>
        <div {...stylex.props(s.grid)}>
          {platforms.map((platform) => (
            <section {...stylex.props(s.card)} key={platform.id} aria-labelledby={`platform-${platform.id}`}>
              <h2 {...stylex.props(s.cardTitle)} id={`platform-${platform.id}`}>
                {platform.name}
              </h2>
              <p {...stylex.props(s.description)}>{platform.detail}</p>
              <a
                {...stylex.props(shared.button, s.action)}
                href={publicAsset(`download/${platform.id}/`, import.meta.env.BASE_URL)}
              >
                Download for {platform.name}
              </a>
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}

export function DownloadPlatformPage({ platform }: { platform: Platform }) {
  const current = platforms.find((item) => item.id === platform)!;
  const packages = manifest.packages[platform];
  return (
    <>
      <SiteHeader />
      <main {...stylex.props(s.main, shared.content)} id="main">
        <DownloadIntro title={`Download for ${current.name}`} />
        <nav {...stylex.props(s.platforms)} aria-label="Download platform">
          {platforms.map((item) => (
            <a
              key={item.id}
              {...stylex.props(s.platformLink, item.id === platform && s.selected)}
              aria-current={item.id === platform ? "page" : undefined}
              href={publicAsset(`download/${item.id}/`, import.meta.env.BASE_URL)}
            >
              {item.name}
            </a>
          ))}
        </nav>
        <div {...stylex.props(s.grid)}>
          {packages.map((pkg, index) => (
            <section {...stylex.props(s.card)} key={pkg.id} aria-labelledby={pkg.id}>
              <h2 {...stylex.props(s.cardTitle)} id={pkg.id}>
                {pkg.label}
              </h2>
              <p {...stylex.props(s.description)}>{pkg.detail}</p>
              <a {...stylex.props(shared.button, index === 0 && shared.primary, s.action)} href={pkg.url}>
                Download {pkg.format}
              </a>
              <span {...stylex.props(s.size)}>{(pkg.size / 1_000_000).toFixed(1)} MB</span>
            </section>
          ))}
          {packages.length === 0 && (
            <p {...stylex.props(s.installText)}>
              Installation packages for {current.name} are not available in this release. You can build OpenIDEA from
              source.
            </p>
          )}
        </div>
        {packages.length > 0 && (
          <section {...stylex.props(s.install)} aria-labelledby="install-title">
            <h2 {...stylex.props(s.installTitle)} id="install-title">
              Installation
            </h2>
            <p {...stylex.props(s.installText)}>{current.instruction}</p>
          </section>
        )}
        <p {...stylex.props(s.other)}>
          <a {...stylex.props(s.notes)} href={publicAsset("download/", import.meta.env.BASE_URL)}>
            All platforms
          </a>
          {" · "}
          <a {...stylex.props(s.notes)} href={docs}>
            Build from source
          </a>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
