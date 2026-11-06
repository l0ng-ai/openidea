/**
 * Per-language semantics behind `lsp/semantic`: each language folder
 * (`python/`, `php/`) registers a provider here, and feature code looks it up
 * by the document's language instead of branching on language names.
 */
import type { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { Tree } from "@lezer/common";
import type { ContributedIntention } from "@/editor/api";

/** One decorated range; `source` says which parse-tree pass produced it. */
export interface SemanticRange {
  from: number;
  to: number;
  className: string;
  source?: "syntax" | "fallback";
}

/** A server token, with the classes the generic mapping already produced. */
export interface SemanticToken {
  type: string;
  modifiers: readonly string[];
  /** Kind from the language's own `symbolKinds` classification, when present. */
  kind: string | undefined;
  /** Classes accumulated so far; the hook appends or removes. */
  classes: string[];
}

/** Documentation of a language construct that has no source declaration. */
export interface ConstructDoc {
  from: number;
  to: number;
  markdown: string;
}

export interface LanguageSemantics {
  /** Classifies identifiers from the parse tree (`"from:to"` → kind). */
  symbolKinds?(tree: Tree, doc: Text): Map<string, string>;
  /** Parse-tree ranges styling what the LSP tokens do not cover. */
  syntaxRanges?(tree: Tree, doc: Text, symbols: Map<string, string>): SemanticRange[];
  /** Fast local guesses shown while the server is pending. */
  fallbackRanges?(
    tree: Tree,
    doc: Text,
    rainbow: ((name: string) => string) | undefined,
    symbols: Map<string, string>,
  ): SemanticRange[];
  /** Extra classes for a server token, on top of the generic ones. */
  tokenClasses?(token: SemanticToken): void;
  /** Whether a server token counts as a local for rainbow colouring; default: the generic rule. */
  isLocal?(token: Pick<SemanticToken, "type" | "modifiers" | "kind">): boolean;
  /** Documentation of the language construct called at `pos`, if there is one. */
  constructAt?(state: EditorState, pos: number): ConstructDoc | null;
  /** Construct documentation by name (completion item detail). */
  constructDocumentation?(name: string): string | null;
  /** Bulb intentions contributed on this language's documents. */
  intentions?(view: EditorView): ContributedIntention[];
  /** Fallback for the Implement Methods action when the server offers no code action. */
  implementMethods?(view: EditorView): Promise<boolean>;
}

const registry: Record<string, LanguageSemantics> = {};

export function registerLanguageSemantics(language: string, semantics: LanguageSemantics): void {
  registry[language.toLowerCase()] = semantics;
}

export function languageSemantics(language: string | null | undefined): LanguageSemantics | undefined {
  return language ? registry[language.toLowerCase()] : undefined;
}

/** Every registered provider; language folders register when their module is imported. */
export function registeredSemantics(): LanguageSemantics[] {
  return Object.values(registry);
}
