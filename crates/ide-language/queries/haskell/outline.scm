(header module: (module) @name) @outline.module
(data_type name: (name) @name) @def.enum
(newtype name: (name) @name) @def.struct
(type_synonym name: (name) @name) @def.type
(type_family name: (name) @name) @def.type
(class name: (name) @name) @def.interface
(instance name: (name) @name patterns: (_) @detail) @outline.namespace
(instance name: (name) @name) @outline.namespace
(data_constructor constructor: (prefix name: (constructor) @name)) @def.enum_member
(data_constructor constructor: (record name: (constructor) @name)) @def.enum_member
(class_declarations (signature name: (variable) @name) @def.method)
(declarations (function name: (variable) @name) @def.function)
(declarations (bind name: (variable) @name) @def.variable)
