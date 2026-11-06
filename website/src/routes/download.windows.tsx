import { createFileRoute } from "@tanstack/react-router";
import { DownloadPlatformPage } from "../components/Downloads";
import { pageHead } from "../lib/metadata";

export const Route = createFileRoute("/download/windows")({
  head: () => pageHead("Download for Windows", "download/windows/"),
  component: () => <DownloadPlatformPage platform="windows" />,
});
