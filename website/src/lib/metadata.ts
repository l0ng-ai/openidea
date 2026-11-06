export function pageHead(title: string, path = "") {
  const siteUrl = import.meta.env.VITE_SITE_URL?.replace(/\/$/, "");
  return {
    meta: [{ title: `${title} — OpenIDEA` }],
    links: siteUrl ? [{ rel: "canonical", href: `${siteUrl}/${path}` }] : [],
  };
}
