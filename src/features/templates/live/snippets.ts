/** Numbered snippet placeholders translated into the existing linked live-template fields. */
import type { ContributedSnippet } from "@/workbench/contributions";
import type { LiveTemplate, TemplateVariable } from "./model";
export function snippetTemplates(s: ContributedSnippet): LiveTemplate[] {
  const variables = new Map<number, TemplateVariable>();
  let body = "";
  for (let i = 0; i < s.body.length;) {
    if (s.body[i] === "\\" && /[$}\\]/.test(s.body[i + 1] ?? "")) {
      body += s.body[i + 1] === "$" ? "$$" : s.body[i + 1];
      i += 2;
      continue;
    }
    const m = /^\$(?:(\d+)|\{(\d+)(?::((?:\\.|[^}])*))?\})/.exec(s.body.slice(i));
    if (m) {
      const n = Number(m[1] ?? m[2]);
      if (n === 0) body += "$END$";
      else {
        const name = `P${n}`;
        const value = m[3]?.replace(/\\([$}\\])/g, "$1");
        if (!variables.has(n) || value !== undefined)
          variables.set(n, { name, defaultValue: value === undefined ? undefined : JSON.stringify(value) });
        body += `$${name}$`;
      }
      i += m[0].length;
    } else {
      body += s.body[i] === "$" ? "$$" : s.body[i];
      i++;
    }
  }
  return s.prefixes.map((abbrev, i) => ({
    id: `${s.id}:${i}`,
    group: s.pluginName,
    pluginOrigin: s.pluginName,
    abbrev,
    description: s.description,
    body,
    contexts: [s.language],
    scope: "any",
    variables: [...variables].sort(([a], [b]) => a - b).map(([, v]) => v),
  }));
}
