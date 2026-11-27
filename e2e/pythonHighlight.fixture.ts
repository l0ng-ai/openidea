import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { openideaHighlightStyle } from "../src/editor/core/cm/highlight";
import { findLanguageDescription, loadSupport } from "../src/editor/core/cm/languages";
import { semanticExtension } from "../src/editor/lsp/semantic";
import { lspDoc } from "../src/editor/lsp/lsp";
import { lspTheme } from "../src/editor/lsp/theme";
import { parseIcls } from "../src/platform/icls";
import { schemeCss } from "../src/platform/colorScheme";
import type { EditorDocContext } from "../src/editor/api";

const attributes = {
  TEXT: { FOREGROUND: "ddeeff", BACKGROUND: "101820" },
  "PY.KEYWORD": { FOREGROUND: "112233" },
  "PY.FUNC_DEFINITION": { FOREGROUND: "224466" },
  "PY.NESTED_FUNC_DEFINITION": { FOREGROUND: "335577" },
  DEFAULT_FUNCTION_CALL: { FOREGROUND: "446688" },
  DEFAULT_LINE_COMMENT: { FOREGROUND: "667788" },
  DEFAULT_BLOCK_COMMENT: { FOREGROUND: "aabbcc" },
  "PY.METHOD_CALL": { FOREGROUND: "557799" },
  "PY.DOC_COMMENT": { FOREGROUND: "6688aa", EFFECT_TYPE: "1" },
  "PY.STRING.B": { FOREGROUND: "7799bb", FONT_TYPE: "1" },
  "PY.VALID_STRING_ESCAPE": { FOREGROUND: "88aacc" },
  "PY.ANNOTATION": { FOREGROUND: "99bbdd", BACKGROUND: "182838" },
  "PY.SELF_PARAMETER": { FOREGROUND: "aa7788" },
  "PY.BUILTIN_NAME": { FOREGROUND: "bb8899" },
  "PY.KEYWORD_ARGUMENT": { FOREGROUND: "cc99aa" },
  "PY.STRING.F": { FOREGROUND: "aa8811" },
  "PY.PREDEFINED_DEFINITION": { FOREGROUND: "bb9922" },
  "PY.PREDEFINED_USAGE": { FOREGROUND: "ccaa33" },
  OPENIDEA_pyLocalVariable: { FOREGROUND: "aa1101" },
  OPENIDEA_pyGlobalVariable: { FOREGROUND: "aa2202" },
  OPENIDEA_pyInstanceAttribute: { FOREGROUND: "aa3303" },
  OPENIDEA_pyClassAttribute: { FOREGROUND: "aa4404" },
  OPENIDEA_pyConstant: { FOREGROUND: "aa5505" },
  OPENIDEA_pyProperty: { FOREGROUND: "aa6606" },
  OPENIDEA_pyTypeParameter: { FOREGROUND: "aa7707" },
};
const xml = `<scheme name="Python" parent_scheme="Darcula"><attributes>${Object.entries(attributes)
  .map(
    ([key, values]) =>
      `<option name="${key}"><value>${Object.entries(values)
        .map(([name, value]) => `<option name="${name}" value="${value}"/>`)
        .join("")}</value></option>`,
  )
  .join("")}</attributes></scheme>`;
const style = document.createElement("style");
style.textContent =
  schemeCss("custom-python", {}, null, { "custom-python": parseIcls(xml).scheme }) +
  "body { margin: 24px; background: #101820; color: #ddeeff; } .cm-editor { font: 14px/1.6 monospace; }";
document.head.append(style);
const support = await loadSupport(findLanguageDescription("Python", "demo.py")!);
new EditorView({
  parent: document.body,
  state: EditorState.create({
    doc: `MAX_SIZE: Final = 10
type Alias = list[int]
fstr = f"value={1}"
name = "global"
T = TypeVar("T")

def outer(x: T) -> T:
    """Syntax Highlighting Demo"""
    def nested(y):
        print(y + 1)
    nested(x)

class Foo[T]:
    count = 0
    def __init__(self: Foo, value: T):
        value = b"newline:\\n"
        local = 1
        self.instance_attr = value
        print(local, MAX_SIZE, name, T)
        self.run(whatever=1) # Comment
        print(self.__doc__)
    @property
    def size(self) -> int:
        return self.instance_attr

def unused(param):
    return 1
`,
    extensions: [
      support!,
      syntaxHighlighting(openideaHighlightStyle),
      lspTheme,
      lspDoc.of({ language: "python" } as EditorDocContext),
      ...(new URLSearchParams(location.search).has("baseline") ? [] : [semanticExtension()]),
    ],
  }),
});
