// NEON, after the grammar and lexer of noctud/intellij-neon. Indentation and literals are in
// src/scanner.c: a literal's end depends on what follows it, which a token regex cannot look at.
export default grammar({
  name: "neon",

  externals: ($) => [$._newline, $._indent, $._dedent, $.literal, $._multiline_string, $._error_sentinel],

  extras: ($) => [/[ \t\r\n]+/, $.comment],

  // In `[a: \n b: 1]` only the colon after `b` tells that `a` has no value.
  conflicts: ($) => [[$.array_pair]],

  rules: {
    document: ($) => seq(optional($._newline), optional($.array)),

    comment: () => token(seq("#", /.*/)),

    // A list may mix pairs and bullets on one level, and `key:` may be followed by bullets at its
    // own indent, so both are items of one array.
    array: ($) => seq($._item, repeat(seq($._newline, $._item))),

    _item: ($) => choice($.pair, $.bullet),

    pair: ($) => prec.right(seq(field("key", $.key), optional(field("value", choice($.value, $._inner_array))))),

    // After `- key: 1` the rest of the mapping sits deeper than the bullet, beside the first pair.
    bullet: ($) =>
      prec.right(
        seq("-", optional(choice(seq($.pair, optional($._inner_array)), field("value", $.value), $._inner_array))),
      ),

    _inner_array: ($) => seq($._indent, $.array, $._dedent),

    key: ($) => seq($._scalar, choice(":", "=")),

    value: ($) =>
      prec.right(choice(seq($.inline_array, optional($.parameters)), repeat1(choice($._scalar, $.parameters)))),

    inline_array: ($) => choice(seq("[", optional($._array_content), "]"), seq("{", optional($._array_content), "}")),

    parameters: ($) => seq("(", optional($._array_content), ")"),

    _array_content: ($) => repeat1(choice($.array_pair, $.value, ",")),

    array_pair: ($) => seq(field("key", $.key), optional(field("value", $.value))),

    _scalar: ($) => choice($.literal, $.string),

    string: ($) => choice($._multiline_string, /'[^'\n]*'/, /"(\\.|[^"\\\n])*"/),
  },
});
