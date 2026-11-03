/**
 * MyBatis mapper assistance: the binding between a mapper interface and its
 * mapper XML, shown as gutter icons on both halves and jumped with a click, plus
 * the context actions that generate a missing statement or the missing `@Param`.
 */
import { registerEditorContribution } from "@/editor/api";
import { mybatisEditor } from "./mapperGutter";
import { installMapperIndex } from "./mapperStore";

export function activate(): () => void {
  const offIndex = installMapperIndex();
  const offContribution = registerEditorContribution({
    id: "mybatis.editor",
    order: 57,
    extensions: (ctx) => (ctx.language === "java" || ctx.language === "xml" ? mybatisEditor(ctx) : []),
  });
  return () => {
    offContribution();
    offIndex();
  };
}
