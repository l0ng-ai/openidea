/** @param {string} [path] */
export function normalizeBasePath(path = "/") {
  const clean = path.replace(/^\/+|\/+$/g, "");
  return clean ? `/${clean}/` : "/";
}

/** @param {string} asset @param {string} [basePath] */
export function publicAsset(asset, basePath = "/") {
  return `${normalizeBasePath(basePath)}${asset.replace(/^\/+/, "")}`;
}
