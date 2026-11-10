/**
 * PHP: no semantic-token extras, but its language constructs (`empty`, `isset`)
 * have no source declaration, so hover and completion get their documentation
 * from here.
 */
import type { LanguageSemantics } from "../languages";
import { registerLanguageSemantics } from "../languages";
import { phpConstructAt, phpConstructDocumentation } from "./constructs";

const phpSemantics: LanguageSemantics = {
  constructAt: (state, pos) => phpConstructAt(state, pos, "php"),
  constructDocumentation: (name) => phpConstructDocumentation("php", name),
};

registerLanguageSemantics("php", phpSemantics);
