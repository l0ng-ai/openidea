#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Indentation and literals of NEON. The literal rules are the flex lexer's of noctud/intellij-neon.

enum TokenType { NEWLINE, INDENT, DEDENT, LITERAL, MULTILINE_STRING, ERROR_SENTINEL };

#define MAX_DEPTH 100

typedef struct {
  bool started;
  bool has_pending;
  uint16_t pending;
  uint16_t depth;
  uint16_t indents[MAX_DEPTH];
} Scanner;

void *tree_sitter_neon_external_scanner_create(void) { return ts_calloc(1, sizeof(Scanner)); }

void tree_sitter_neon_external_scanner_destroy(void *payload) { ts_free(payload); }

unsigned tree_sitter_neon_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = payload;
  unsigned size = offsetof(Scanner, indents) + s->depth * sizeof(uint16_t);
  if (size > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) return 0;
  memcpy(buffer, s, size);
  return size;
}

void tree_sitter_neon_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *s = payload;
  memset(s, 0, sizeof(Scanner));
  if (length > 0) memcpy(s, buffer, length);
}

static uint16_t top(const Scanner *s) { return s->depth ? s->indents[s->depth - 1] : 0; }

static bool in_range(int32_t c, int32_t from, int32_t to) { return c >= from && c <= to; }

// What may follow `:` or `-` for it to start a literal rather than be punctuation.
static bool after_mark(int32_t c) {
  return c == '!' || c == '#' || c == '$' || c == '%' || c == '&' || c == '*' || c == '~' || in_range(c, 0x2D, 0x5C) ||
         in_range(c, 0x5E, 0x7C) || in_range(c, 0xA0, 0xFFFF);
}

// What may follow `:` for it to stay inside a literal.
static bool after_inner_colon(int32_t c) {
  return c == '*' || c == '~' || in_range(c, 0x21, 0x28) || in_range(c, 0x2D, 0x5C) || in_range(c, 0x5E, 0x7C) ||
         in_range(c, 0xA0, 0xFFFF);
}

static bool literal_char(int32_t c) { return c > 0x20 && !strchr(",:=]})(", c < 128 ? c : ' '); }

static bool scan_literal(TSLexer *lexer) {
  int32_t c = lexer->lookahead;
  if (c == ':' || c == '-') {
    lexer->advance(lexer, false);
    if (!after_mark(lexer->lookahead)) return false;
  } else if (c <= 0x20 || (c < 128 && strchr("#\"',=[]{}()`", c))) {
    return false;
  }
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  for (;;) {
    c = lexer->lookahead;
    if (literal_char(c)) {
      lexer->advance(lexer, false);
    } else if (c == ':') {
      lexer->advance(lexer, false);
      if (!after_inner_colon(lexer->lookahead)) break;
    } else if (c == ' ' || c == '\t') {
      while (lexer->lookahead == ' ' || lexer->lookahead == '\t') lexer->advance(lexer, false);
      if (lexer->lookahead == '#' || !literal_char(lexer->lookahead)) break;
      lexer->advance(lexer, false);
    } else {
      break;
    }
    lexer->mark_end(lexer);
  }
  lexer->result_symbol = LITERAL;
  return true;
}

// `"""` or `'''`, ending its line, up to a line that starts with the same quotes.
static bool scan_multiline(TSLexer *lexer) {
  int32_t quote = lexer->lookahead;
  for (int i = 0; i < 3; i++) {
    if (lexer->lookahead != quote) return false;
    lexer->advance(lexer, false);
  }
  if (lexer->lookahead != '\n') return false;
  while (!lexer->eof(lexer)) {
    lexer->advance(lexer, false);
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') lexer->advance(lexer, false);
    int quotes = 0;
    while (quotes < 3 && lexer->lookahead == quote) {
      lexer->advance(lexer, false);
      quotes++;
    }
    if (quotes == 3) {
      lexer->mark_end(lexer);
      lexer->result_symbol = MULTILINE_STRING;
      return true;
    }
    while (!lexer->eof(lexer) && lexer->lookahead != '\n') lexer->advance(lexer, false);
  }
  return false;
}

static bool emit(TSLexer *lexer, enum TokenType type) {
  lexer->result_symbol = type;
  return true;
}

static bool push_indent(Scanner *s, TSLexer *lexer, uint16_t indent) {
  if (s->depth == MAX_DEPTH) return false;
  s->indents[s->depth++] = indent;
  return emit(lexer, INDENT);
}

static bool scan_line_start(Scanner *s, TSLexer *lexer, const bool *valid, uint16_t indent) {
  if (indent > top(s)) return valid[INDENT] && push_indent(s, lexer, indent);
  if (indent < top(s)) {
    if (!valid[DEDENT]) return false;
    s->depth--;
    s->pending = indent;
    s->has_pending = true;
    return emit(lexer, DEDENT);
  }
  return valid[NEWLINE] && emit(lexer, NEWLINE);
}

bool tree_sitter_neon_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid) {
  Scanner *s = payload;
  // The grammar never uses this symbol, so it is valid only during error recovery.
  if (valid[ERROR_SENTINEL]) return false;

  // Unwinding several levels, then a sibling, or a mapping that sits deeper than its bullet.
  if (s->has_pending) {
    s->has_pending = false;
    if (s->pending < top(s) && valid[DEDENT]) {
      s->depth--;
      s->has_pending = true;
      return emit(lexer, DEDENT);
    }
    if (s->pending > top(s)) return valid[INDENT] && push_indent(s, lexer, s->pending);
    return valid[NEWLINE] && emit(lexer, NEWLINE);
  }

  bool block = valid[NEWLINE] || valid[INDENT] || valid[DEDENT];
  bool saw_newline = false;
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t' || lexer->lookahead == '\r' || lexer->lookahead == '\n') {
    saw_newline |= lexer->lookahead == '\n';
    lexer->advance(lexer, true);
  }

  if (lexer->eof(lexer)) {
    if (valid[DEDENT] && s->depth > 0) {
      s->depth--;
      return emit(lexer, DEDENT);
    }
    return false;
  }

  // A comment line says nothing about nesting; the built-in lexer takes it as an extra.
  if (lexer->lookahead == '#') return false;

  uint16_t column = (uint16_t)lexer->get_column(lexer);
  // A file may be indented as a whole, and its first line sets the base.
  if (!s->started) {
    s->started = true;
    s->indents[0] = column;
    s->depth = 1;
    return valid[NEWLINE] && emit(lexer, NEWLINE);
  }
  if (saw_newline && block) return scan_line_start(s, lexer, valid, column);

  int32_t c = lexer->lookahead;
  if ((c == '"' || c == '\'') && valid[MULTILINE_STRING]) return scan_multiline(lexer);
  return valid[LITERAL] && scan_literal(lexer);
}
