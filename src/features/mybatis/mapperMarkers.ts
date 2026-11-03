/**
 * Which lines of a mapper get a jump icon, and where the icon takes you: the
 * Java methods that have a statement of the same `id`, and the statements whose
 * namespace names an interface with a method of that `id`.
 *
 * Pure: it turns a parsed pair of halves into markers. `mapperGutter` places them
 * in the editor and opens them on a click.
 */
import type { Location } from "@/platform/ipc";
import { basename } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { colAt } from "./mask";
import type { JavaMapper, MapperMethod } from "./java";
import type { MapperXml, XmlStatement } from "./xml";
import type { Found } from "./mapperStore";

export interface MapperMarker {
  /** 0-based line the icon sits on. */
  line: number;
  /** Name bound on both sides. */
  name: string;
  /** Where a click lands: several for an overloaded method or a `databaseId` pair. */
  targets: Location[];
  tooltip: string;
  chooserTitle: string;
}

/** Location of an XML statement: its opening tag. */
function statementLocation(found: Found<MapperXml>, statement: XmlStatement): Location {
  const col = colAt(found.text, statement.at);
  return {
    path: found.path,
    range: {
      start: { line: statement.line, col },
      end: { line: statement.line, col: col + statement.tag.length },
    },
  };
}

/** Location of a declared method: its name. */
function methodLocation(found: Found<JavaMapper>, method: MapperMethod): Location {
  const col = colAt(found.text, method.at);
  return {
    path: found.path,
    range: {
      start: { line: method.line, col },
      end: { line: method.line, col: col + method.name.length },
    },
  };
}

/** Icons for a mapper interface: one per method a statement is bound to. */
export function javaMarkers(mapper: JavaMapper, xml: Found<MapperXml> | null): MapperMarker[] {
  if (!xml) return [];
  const file = basename(xml.path);
  const out: MapperMarker[] = [];
  for (const method of mapper.methods) {
    const targets = xml.parsed.statements
      .filter((s) => s.bindable && s.id === method.name)
      .map((s) => statementLocation(xml, s));
    push(
      out,
      {
        line: method.line,
        name: method.name,
        targets,
        tooltip: tx`Statement in ${file}`,
        chooserTitle: chooseStatement(method.name, targets.length),
      },
      chooseStatement,
    );
  }
  return out;
}

/** Icons for a mapper XML: one per statement whose interface method exists. */
export function xmlMarkers(xml: MapperXml, java: Found<JavaMapper> | null): MapperMarker[] {
  if (!java) return [];
  const file = basename(java.path);
  const out: MapperMarker[] = [];
  for (const statement of xml.statements) {
    if (!statement.bindable) continue;
    const targets = java.parsed.methods.filter((m) => m.name === statement.id).map((m) => methodLocation(java, m));
    push(
      out,
      {
        line: statement.line,
        name: statement.id,
        targets,
        tooltip: tx`Mapper method in ${file}`,
        chooserTitle: chooseMethod(statement.id, targets.length),
      },
      chooseMethod,
    );
  }
  return out;
}

/** Add `marker` unless it has nothing to jump to; merge it into the line before. */
function push(out: MapperMarker[], marker: MapperMarker, title: (name: string, count: number) => string): void {
  if (!marker.targets.length) return;
  const previous = out[out.length - 1];
  // The same `id` declared twice on one line (`databaseId` variants) is one icon.
  if (previous && previous.line === marker.line && previous.name === marker.name) {
    const targets = dedupe([...previous.targets, ...marker.targets]);
    previous.targets = targets;
    previous.chooserTitle = title(marker.name, targets.length);
    return;
  }
  out.push({ ...marker, targets: [...marker.targets] });
}

/** Two statements of one id bind the same method: the chooser must not repeat it. */
function dedupe(targets: readonly Location[]): Location[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = `${t.path}:${t.range.start.line}:${t.range.start.col}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const chooseStatement = (name: string, count: number) => tx`Choose Statement of ${name} (${count} found)`;

const chooseMethod = (name: string, count: number) => tx`Choose Mapper Method of ${name} (${count} found)`;
