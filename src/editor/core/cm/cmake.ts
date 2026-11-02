import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const COMMANDS = new Set(
  `
add_compile_definitions add_compile_options add_custom_command add_custom_target add_definitions
add_dependencies add_executable add_library add_link_options add_subdirectory add_test aux_source_directory
build_command build_name cmake_file_api cmake_host_system_information cmake_language cmake_minimum_required
cmake_parse_arguments cmake_path cmake_policy configure_file create_test_sourcelist
ctest_build ctest_configure ctest_coverage ctest_empty_binary_directory ctest_memcheck ctest_read_custom_files
ctest_run_script ctest_sleep ctest_start ctest_submit ctest_test ctest_update ctest_upload define_property
enable_language enable_testing exec_program execute_process export export_library_dependencies file
find_file find_library find_package find_path find_program fltk_wrap_ui get_cmake_property
get_directory_property get_filename_component get_property get_source_file_property get_target_property
get_test_property include include_directories include_external_msproject include_guard include_regular_expression
install install_files install_programs install_targets link_directories link_libraries list load_cache
load_command make_directory mark_as_advanced math message option output_required_files project qt_wrap_cpp
qt_wrap_ui remove remove_definitions separate_arguments set set_directory_properties set_property
set_source_files_properties set_target_properties set_tests_properties site_name source_group string
subdir_depends subdirs target_compile_definitions target_compile_features target_compile_options
 target_include_directories target_link_directories target_link_libraries target_link_options
 target_precompile_headers target_sources try_compile try_run unset use_mangled_mesa utility_source
variable_requires variable_watch write_file
`
    .trim()
    .split(/\s+/),
);

const CONTROL = new Set(
  `
block break continue else elseif endblock endforeach endfunction endif endmacro endwhile
foreach function if macro return while
`
    .trim()
    .split(/\s+/),
);

const ARGUMENTS = new Set(
  `
VERSION LANGUAGES NAME COMMAND COMMANDS WORKING_DIRECTORY COMMENT DEPENDS OUTPUT OUTPUTS BYPRODUCTS
PRIVATE PUBLIC INTERFACE REQUIRED QUIET COMPONENTS OPTIONAL_COMPONENTS CONFIG MODULE EXACT GLOBAL
APPEND PROPERTY PROPERTIES CACHE INTERNAL FORCE PARENT_SCOPE PATH FILEPATH BOOL STRING
DIRECTORY DIRECTORIES FILE FILES TARGET TARGETS DESTINATION EXPORT NAMESPACE TYPE STATIC SHARED
MODULE OBJECT IMPORTED ALIAS EXCLUDE_FROM_ALL ALL BEFORE AFTER SYSTEM CONFIGURE_DEPENDS
AND OR NOT DEFINED EXISTS IS_DIRECTORY IS_SYMLINK IS_ABSOLUTE MATCHES LESS GREATER EQUAL
LESS_EQUAL GREATER_EQUAL STRLESS STRGREATER STREQUAL VERSION_LESS VERSION_GREATER VERSION_EQUAL
VERSION_LESS_EQUAL VERSION_GREATER_EQUAL IN_LIST COMMAND POLICY TARGET TEST
`
    .trim()
    .split(/\s+/),
);

interface State {
  quoted: boolean;
  bracket: { end: string; style: "comment" | "string" } | null;
  depth: number;
  definition: boolean;
}

function bracket(stream: StringStream, state: State): string {
  const { end, style } = state.bracket!;
  const close = stream.string.indexOf(end, stream.pos);
  if (close < 0) stream.skipToEnd();
  else {
    stream.pos = close + end.length;
    state.bracket = null;
  }
  return style;
}

function expansion(stream: StringStream): boolean {
  const variable = stream.match(/^\$(?:ENV|CACHE)?\{/);
  const generator = !variable && stream.match(/^\$</);
  if (!variable && !generator) return false;
  let depth = 1;
  while (!stream.eol() && depth) {
    if (generator && stream.match("$<")) depth++;
    else {
      const ch = stream.next();
      if (variable && ch === "{") depth++;
      if (ch === (variable ? "}" : ">")) depth--;
    }
  }
  return true;
}

const parser: StreamParser<State> = {
  name: "cmake",
  startState: () => ({ quoted: false, bracket: null, depth: 0, definition: false }),
  copyState: (s) => ({ ...s, bracket: s.bracket && { ...s.bracket } }),
  languageData: { commentTokens: { line: "#", block: { open: "#[[", close: "]]" } } },
  tokenTable: {
    command: t.standard(t.function(t.variableName)),
    cmakeVariable: t.standard(t.variableName),
    expansion: t.special(t.variableName),
    functionDefinition: t.function(t.definition(t.variableName)),
  },
  token(stream, state) {
    if (state.bracket) return bracket(stream, state);
    if (expansion(stream)) return "expansion";
    if (stream.eat("\\")) {
      stream.next();
      return "escape";
    }
    if (stream.eat('"')) {
      state.quoted = !state.quoted;
      return "string";
    }
    if (state.quoted) {
      while (!stream.eol() && !/["\\]/.test(stream.peek()!)) {
        if (stream.match(/^\$(?:(?:ENV|CACHE)?\{|<)/, false)) break;
        stream.next();
      }
      return "string";
    }
    if (stream.eatSpace()) return null;
    const open = stream.match(/^(#?)\[(=*)\[/);
    if (open) {
      const [, comment, equals] = open as RegExpMatchArray;
      state.bracket = { end: `]${equals}]`, style: comment ? "comment" : "string" };
      return bracket(stream, state);
    }
    if (stream.eat("#")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.eat("(")) {
      state.depth++;
      return "paren";
    }
    if (stream.eat(")")) {
      state.depth = Math.max(0, state.depth - 1);
      state.definition = false;
      return "paren";
    }
    const word = stream.match(/^[^\s()#"\\$]+/);
    if (word) {
      const text = (word as RegExpMatchArray)[0];
      if (state.depth === 0 && /^[A-Za-z_]\w*$/.test(text) && stream.match(/^\s*\(/, false)) {
        const command = text.toLowerCase();
        state.definition = command === "function" || command === "macro";
        return CONTROL.has(command) ? "keyword" : COMMANDS.has(command) ? "command" : "variableName.function";
      }
      if (state.definition) {
        state.definition = false;
        return "functionDefinition";
      }
      if (/^[+-]?\d+(?:\.\d+)*(?:\.\.\.<?\d+(?:\.\d+)*)?$/.test(text)) return "number";
      if (/^(?:ON|OFF|TRUE|FALSE|YES|NO|Y|N|IGNORE|NOTFOUND)$/i.test(text)) return "bool";
      if (/^(?:CMAKE|PROJECT|CTEST|CPACK)_\w+$/.test(text)) return "cmakeVariable";
      if (ARGUMENTS.has(text)) return "keyword";
      return null;
    }
    stream.next();
    return null;
  },
};

export const cmakeLanguage = StreamLanguage.define(parser);
