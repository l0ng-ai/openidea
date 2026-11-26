import { tx } from "@/platform/i18n";
import { identName, lex } from "./sql/lexer";

export interface WorkspaceRelation {
  source: "left" | "right";
  schema: string;
  table: string;
  alias: string;
  key: string;
}

const sides = ["left", "right"] as const;
type Side = (typeof sides)[number];
type SourceNames = Record<Side, string>;

export function workspaceSourceNames(left: string, right: string): SourceNames {
  const unique = left.toLowerCase() !== right.toLowerCase();
  const preferred = (name: string, side: Side) =>
    unique && name.trim() && !/^(left|right)$/i.test(name) ? name : side;
  return { left: preferred(left, "left"), right: preferred(right, "right") };
}

export function workspaceSourceSide(name: string, names: SourceNames): Side | undefined {
  return sides.find((side) => name === side || name === names[side]);
}

/** Compile the workspace's direct table JOIN to structured host arguments. */
export function workspaceJoinQuery(
  sql: string,
  names: SourceNames = { left: "left", right: "right" },
): [WorkspaceRelation, WorkspaceRelation] {
  if (sql.length > 65_536) throw new Error(tx("Workspace SQL exceeds 65,536 characters."));
  const { tokens } = lex(sql, "postgres");
  let i = 0;
  const take = (expected: string) => {
    if (tokens[i]?.upper !== expected) return false;
    ++i;
    return true;
  };
  const need = (expected: string) => {
    if (!take(expected)) throw new Error(tx`Expected ${expected} in the workspace query.`);
  };
  const identifier = () => {
    const token = tokens[i++];
    if (token?.kind === "word") return token.text.toLowerCase();
    if (token?.kind === "quoted" && /^"(?:[^"]|"")*"$/.test(token.text)) return identName(token);
    throw new Error(tx("Expected an identifier in the workspace query."));
  };
  const relation = (): WorkspaceRelation => {
    need("#");
    const name = identifier();
    const source = workspaceSourceSide(name, names);
    if (!source) throw new Error(tx("Choose a source from completion after #, or use #left or #right."));
    need(".");
    const schema = identifier();
    need(".");
    const table = identifier();
    const alias = take("AS") || !["INNER", "JOIN", "ON"].includes(tokens[i]?.upper ?? "") ? identifier() : name;
    return { source, schema, table, alias, key: "" };
  };
  const column = (relations: WorkspaceRelation[]) => {
    const alias = identifier();
    need(".");
    const key = identifier();
    const target = relations.find((r) => r.alias === alias);
    if (!target || target.key) throw new Error(tx("The join must compare one column from each table."));
    target.key = key;
  };
  need("SELECT");
  need("*");
  need("FROM");
  const first = relation();
  take("INNER");
  need("JOIN");
  const second = relation();
  if (first.source === second.source || first.alias === second.alias)
    throw new Error(tx("Use two different sources and table aliases."));
  need("ON");
  const relations: [WorkspaceRelation, WorkspaceRelation] = [first, second];
  column(relations);
  need("=");
  column(relations);
  take(";");
  if (i !== tokens.length) throw new Error(tx("The workspace supports one direct equality JOIN per run."));
  return relations;
}
