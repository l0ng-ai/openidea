import { createFileRoute } from "@tanstack/react-router";
import { Home } from "../components/Home";
import { pageHead } from "../lib/metadata";

export const Route = createFileRoute("/")({
  head: () => pageHead("The IDE you know, rebuilt in Rust."),
  component: Home,
});
