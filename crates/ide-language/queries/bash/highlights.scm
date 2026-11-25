; Shell scripts: drawn over the stream mode, which knows only fixed word lists.
; The last matching pattern wins.

[
  (string)
  (raw_string)
  (ansi_c_string)
  (translated_string)
  (heredoc_body)
  (heredoc_start)
] @string

[
  (command_substitution)
  (process_substitution)
  (expansion)
  (simple_expansion)
] @embedded

(comment) @comment

[
  "case"
  "do"
  "done"
  "elif"
  "else"
  "esac"
  "fi"
  "for"
  "function"
  "if"
  "in"
  "select"
  "then"
  "until"
  "while"
  "declare"
  "export"
  "local"
  "readonly"
  "typeset"
  "unset"
  "unsetenv"
] @keyword

(command_name) @function.command
(function_definition name: (word) @function.definition)

(variable_name) @variable
(special_variable_name) @variable

[
  (number)
  (file_descriptor)
] @number
