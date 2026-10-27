(class_name_statement name: (name) @name) @def.class
(class_definition name: (name) @name) @def.class
(function_definition name: (name) @name parameters: (parameters) @detail) @def.function
(constructor_definition "_init" @name parameters: (parameters) @detail) @def.constructor
(signal_statement name: (name) @name) @def.event
(enum_definition name: (name) @name) @def.enum
(enumerator left: (identifier) @name) @def.enum_member
(const_statement name: (name) @name) @def.constant
(source (variable_statement name: (name) @name) @def.field)
(source (export_variable_statement name: (name) @name) @def.field)
(source (onready_variable_statement name: (name) @name) @def.field)
(class_body (variable_statement name: (name) @name) @def.field)
(class_body (export_variable_statement name: (name) @name) @def.field)
(class_body (onready_variable_statement name: (name) @name) @def.field)
