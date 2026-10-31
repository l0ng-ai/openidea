import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { publicAsset } from "../lib/paths.mjs";
import { DevStyles } from "../components/DevStyles";
import "../styles/global.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "OpenIDEA — The IDE you know, rebuilt in Rust." },
      {
        name: "description",
        content:
          "An open-source IDE with the keymap, tool windows and Search Everywhere you already know. Built with a Rust core for macOS, Windows and Linux.",
      },
      { name: "theme-color", content: "#191a1c" },
    ],
    links: [{ rel: "icon", type: "image/svg+xml", href: publicAsset("mark.svg", import.meta.env.BASE_URL) }],
  }),
  component: Root,
});

function Root() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <DevStyles />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
