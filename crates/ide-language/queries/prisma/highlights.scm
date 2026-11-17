; Prisma schema highlighting (our captures, not the grammar crate's). Later patterns win.

(identifier) @variable
(developer_comment) @comment
(comment) @comment.doc
(number) @number
(string) @string
[(true) (false) (null)] @keyword

(variable) @property
(column_declaration . (identifier) @property)
(type_expression . (identifier) @variable.parameter)
(enumeral (identifier) @constant)

(column_type (identifier) @type)
(column_type (call_expression (identifier) @type))
(call_expression (identifier) @function)

(model_declaration (identifier) @type)
(view_declaration (identifier) @type)
(type_declaration (identifier) @type)
(type_declaration (type_declaration_type) @type)
(enum_declaration (identifier) @type)
(datasource_declaration (identifier) @type)
(generator_declaration (identifier) @type)

(attribute (identifier) @attribute)
(attribute (call_expression (identifier) @attribute))
(attribute (member_expression (identifier) @attribute (property_identifier) @attribute))
(attribute (call_expression (member_expression (identifier) @attribute (property_identifier) @attribute)))
(block_attribute_declaration (identifier) @attribute)
(block_attribute_declaration (call_expression (identifier) @attribute))
["@" "@@"] @attribute

["datasource" "enum" "generator" "model" "type" "view"] @keyword

["(" ")" "[" "]" "{" "}"] @punctuation.bracket
["," ":" "."] @punctuation.delimiter
(maybe) @operator
"=" @operator
