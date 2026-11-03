/**
 * MyBatis mapper assistance: the binding between a mapper interface and its
 * mapper XML, shown as gutter icons on both halves and jumped with a click.
 *
 * Statement generation (`Generate XML Statement`, `Generate @Param`) is a later
 * step of the same feature; it reuses the resolution installed here.
 */
import { registerEditorContribution } from "@/editor/api";
import { mybatisGutter } from "./mapperGutter";
import { installMapperIndex } from "./mapperStore";

export function activate(): () => void {
  const offIndex = installMapperIndex();
  const offContribution = registerEditorContribution({
    id: "mybatis.mapperGutter",
    order: 57,
    extensions: (ctx) => (ctx.language === "java" || ctx.language === "xml" ? mybatisGutter(ctx) : []),
  });
  return () => {
    offContribution();
    offIndex();
  };
}
