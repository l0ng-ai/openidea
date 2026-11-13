(model_declaration (identifier) @name) @def.class
(view_declaration (identifier) @name) @def.class
(type_declaration . (identifier) @name (statement_block)) @def.struct
(enum_declaration (identifier) @name) @def.enum
(enumeral (identifier) @name) @def.enum_member
(datasource_declaration (identifier) @name) @outline.module
(generator_declaration (identifier) @name) @outline.module
(column_declaration . (identifier) @name) @def.field
