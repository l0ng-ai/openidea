import { createFileRoute } from "@tanstack/react-router";
import { DownloadPlatformPage } from "../components/Downloads";
import { pageHead } from "../lib/metadata";

export const Route = createFileRoute("/download/linux")({
  head: () => pageHead("Download for Linux", "download/linux/"),
  component: () => <DownloadPlatformPage platform="linux" />,
});
