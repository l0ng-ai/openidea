; GDScript highlighting (the grammar crate ships no query). Later patterns win.

(identifier) @variable
(name) @variable

(comment) @comment
[(region_start) (region_end)] @comment
(string) @string
(escape_sequence) @string.escape
[(string_name) (node_path) (get_node)] @string.special
(integer) @number
(float) @number
[(true) (false) (null)] @constant.builtin

(type) @type
(type (identifier) @type)
(extends_statement (type) @type)
(class_name_statement name: (name) @type)
(class_definition name: (name) @type)
(enum_definition name: (name) @type)
(enumerator left: (identifier) @constant)

(function_definition name: (name) @function.definition)
(constructor_definition "_init" @function.definition)
(lambda name: (name) @function.definition)
(signal_statement name: (name) @function.definition)
(call (identifier) @function)
(attribute_call (identifier) @function)
(base_call (identifier) @function)

(attribute (identifier) (identifier) @variable.member)

((identifier) @constant
  (#lua-match? @constant "^[A-Z][A-Z_0-9]*$"))
((identifier) @variable.builtin
  (#lua-match? @variable.builtin "^self$"))
(const_statement name: (name) @constant)

(typed_parameter (identifier) @variable.parameter)
(default_parameter (identifier) @variable.parameter)
(typed_default_parameter (identifier) @variable.parameter)

(annotation "@" @attribute (identifier) @attribute)
[(remote_keyword) (static_keyword)] @keyword
[(breakpoint_statement) (pass_statement) (break_statement) (continue_statement)] @keyword

[
  "if" "elif" "else" "for" "while" "match" "when" "return" "await"
  "func" "class" "class_name" "extends" "signal" "enum" "const" "var"
  "set" "get" "setget" "onready" "export" "in" "is" "as" "and" "or" "not"
] @keyword

[
  "+" "-" "*" "/" "%" "**" "<<" ">>" "&" "|" "^" "~" "!" "&&" "||"
  "==" "!=" "<" "<=" ">" ">=" "=" ":=" "+=" "-=" "*=" "/=" "%=" "**="
  "<<=" ">>=" "&=" "|=" "^=" "->"
] @operator

["(" ")" "[" "]" "{" "}"] @punctuation.bracket
["," "." ":" ";"] @punctuation.delimiter
