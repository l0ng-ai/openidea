import { createFileRoute } from "@tanstack/react-router";
import { DownloadPlatformPage } from "../components/Downloads";
import { pageHead } from "../lib/metadata";

export const Route = createFileRoute("/download/macos")({
  head: () => pageHead("Download for macOS", "download/macos/"),
  component: () => <DownloadPlatformPage platform="macos" />,
});
