import { createFileRoute } from "@tanstack/react-router";
import { DownloadsPage } from "../components/Downloads";
import { pageHead } from "../lib/metadata";

export const Route = createFileRoute("/download/")({
  head: () => pageHead("Download", "download/"),
  component: DownloadsPage,
});
