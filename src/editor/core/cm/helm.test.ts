import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { completedSyntaxTree } from "@/test/syntax";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { findLanguageDescription, loadSupport } from "./languages";

async function tokens(source: string) {
  const desc = findLanguageDescription("Helm Template", "templates/applications.yaml")!;
  const support = await loadSupport(desc);
  const state = EditorState.create({ doc: source, extensions: [support!] });
  const result: { text: string; style: string }[] = [];
  highlightTree(completedSyntaxTree(state), classHighlighter, (from, to, style) =>
    result.push({ text: source.slice(from, to), style }),
  );
  return result;
}

describe("Helm Template mode", () => {
  it("highlights YAML outside and Go template actions inside {{ … }}", async () => {
    const src = [
      "{{- range .Values.applications }}",
      "{{- $config := $.Values.config -}}",
      "apiVersion: argoproj.io/v1alpha1",
      "metadata:",
      '  name: {{ printf "example.%s" .name | quote }}',
      '  image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"',
      "{{/* block note */}}",
      "{{- end }}",
    ].join("\n");
    const out = await tokens(src);
    expect(out).toContainEqual(expect.objectContaining({ text: "range", style: "tok-keyword" }));
    expect(out).toContainEqual(expect.objectContaining({ text: "$config", style: "tok-variableName" }));
    expect(out).toContainEqual(expect.objectContaining({ text: ".Values.applications", style: "tok-propertyName" }));
    expect(out).toContainEqual(
      expect.objectContaining({ text: ".Values.image.repository", style: "tok-propertyName" }),
    );
    expect(out).toContainEqual(expect.objectContaining({ text: "apiVersion", style: "tok-propertyName" }));
    expect(out).toContainEqual(expect.objectContaining({ text: "{{/* block note */}}", style: "tok-comment" }));
    expect(out).toContainEqual(expect.objectContaining({ text: "end", style: "tok-keyword" }));
  });

  it("keeps multi-line {{/* … */}} comments across lines", async () => {
    const out = await tokens("{{/* line 1\nline 2 */}}\nreplicas: 3");
    expect(out).toContainEqual(expect.objectContaining({ text: "{{/* line 1", style: "tok-comment" }));
    expect(out).toContainEqual(expect.objectContaining({ text: "line 2 */}}", style: "tok-comment" }));
    expect(out).toContainEqual(expect.objectContaining({ text: "replicas", style: "tok-propertyName" }));
  });
});
