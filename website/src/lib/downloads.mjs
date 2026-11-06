/** @typedef {"macos" | "windows" | "linux"} Platform */
/** @typedef {{id:string,label:string,detail:string,format:string,url:string,name:string,size:number}} DownloadPackage */
/** @typedef {{tag_name:string,html_url:string,draft?:boolean,prerelease?:boolean,assets:{name:string,browser_download_url:string,size:number}[]}} Release */

/** @param {string} userAgent @param {number} [touchPoints] @returns {Platform | null} */
export function detectDesktopPlatform(userAgent, touchPoints = 0) {
  if (/Android|iPhone|iPad|iPod|Windows Phone|CrOS/i.test(userAgent)) return null;
  if (/Macintosh|Mac OS X/i.test(userAgent)) return touchPoints > 1 ? null : "macos";
  if (/Windows NT/i.test(userAgent)) return "windows";
  if (/Linux/i.test(userAgent)) return "linux";
  return null;
}

/** @type {{platform:Platform,id:string,label:string,detail:string,format:string,pattern:RegExp}[]} */
const installers = [
  {
    platform: "macos",
    id: "mac-arm",
    label: "Apple Silicon",
    detail: "Macs with an Apple Silicon processor",
    format: "DMG",
    pattern: /^OpenIDEA.*_(?:aarch64|arm64)\.dmg$/i,
  },
  {
    platform: "macos",
    id: "mac-intel",
    label: "Intel",
    detail: "Macs with an Intel processor",
    format: "DMG",
    pattern: /^OpenIDEA.*_x64\.dmg$/i,
  },
  {
    platform: "windows",
    id: "windows-exe",
    label: "Windows installer",
    detail: "64-bit Intel and AMD PCs",
    format: "EXE",
    pattern: /^OpenIDEA.*_x64-setup\.exe$/i,
  },
  {
    platform: "windows",
    id: "windows-msi",
    label: "MSI package",
    detail: "64-bit installer for managed deployments",
    format: "MSI",
    pattern: /^OpenIDEA.*_x64(?:_[\w-]+)?\.msi$/i,
  },
  {
    platform: "linux",
    id: "linux-appimage",
    label: "AppImage",
    detail: "Standalone app for x86_64 Linux",
    format: "AppImage",
    pattern: /^OpenIDEA.*_amd64\.AppImage$/i,
  },
  {
    platform: "linux",
    id: "linux-deb",
    label: "Debian / Ubuntu",
    detail: "DEB package for x86_64",
    format: "DEB",
    pattern: /^OpenIDEA.*_amd64\.deb$/i,
  },
  {
    platform: "linux",
    id: "linux-rpm",
    label: "Fedora / RHEL",
    detail: "RPM package for x86_64",
    format: "RPM",
    pattern: /^OpenIDEA.*\.x86_64\.rpm$/i,
  },
];

/** @param {Release} release */
export function buildDownloadManifest(release) {
  if (release.draft || release.prerelease || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error("Expected a published stable release");
  }
  const prefix = `https://github.com/l0ng-ai/openidea/releases/download/${release.tag_name}/`;
  /** @type {Record<Platform, DownloadPackage[]>} */
  const packages = { macos: [], windows: [], linux: [] };
  for (const installer of installers) {
    const asset = release.assets.find((item) => installer.pattern.test(item.name));
    if (!asset) continue;
    if (
      !asset.browser_download_url.startsWith(prefix) ||
      decodeURIComponent(new URL(asset.browser_download_url).pathname.split("/").pop() ?? "") !== asset.name
    ) {
      throw new Error(`Unexpected download URL for ${asset.name}`);
    }
    packages[installer.platform].push({
      id: installer.id,
      label: installer.label,
      detail: installer.detail,
      format: installer.format,
      url: asset.browser_download_url,
      name: asset.name,
      size: asset.size,
    });
  }
  if (!Object.values(packages).some((items) => items.length)) throw new Error("No desktop installers in release");
  return { version: release.tag_name.replace(/^v/, ""), tag: release.tag_name, releaseUrl: release.html_url, packages };
}
