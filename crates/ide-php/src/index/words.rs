//! The words of a file for the word index: every identifier-like run of
//! the text, wherever it is (code, comments, strings), so a search finds
//! PHPDoc and string references too.

/// Longer runs are not indexed (generated data, base64 blobs).
const MAX_WORD: usize = 80;

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

/// The distinct lower-case words of `text`, sorted: runs of letters,
/// digits, `_` and non-ASCII characters that don't start with a digit
/// (`$name` gives `name`, `App\Foo` gives `app` and `foo`). Reserved
/// words are kept: methods, constants and enum cases may be named `list`
/// or `Default`.
pub fn words(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if !is_word_byte(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && is_word_byte(bytes[i]) {
            i += 1;
        }
        // Runs split only at ASCII bytes, so they are whole UTF-8.
        let run = &text[start..i];
        if bytes[start].is_ascii_digit() || run.len() > MAX_WORD {
            continue;
        }
        out.push(run.to_ascii_lowercase());
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// Whether `text` contains `word` as a whole word (ASCII case-insensitive).
pub(crate) fn contains_word(text: &str, word: &str) -> bool {
    let (bytes, word) = (text.as_bytes(), word.as_bytes());
    if word.is_empty() || word.len() > bytes.len() {
        return false;
    }
    (0..=bytes.len() - word.len()).any(|i| {
        bytes[i..i + word.len()].eq_ignore_ascii_case(word)
            && (i == 0 || !is_word_byte(bytes[i - 1]))
            && bytes.get(i + word.len()).is_none_or(|&b| !is_word_byte(b))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_identifiers_everywhere() {
        let text = "<?php\nuse App\\Model\\Book;\n/** @var Book[] $shelf */\n$x = 'App\\\\ünïcode_9';\n$y2 = 42abc;";
        assert_eq!(words(text), ["app", "book", "model", "php", "shelf", "use", "var", "x", "y2", "ünïcode_9"]);
    }

    #[test]
    fn whole_words_only() {
        assert!(contains_word("$book->findBook()", "findbook"));
        assert!(contains_word("Book", "book"));
        assert!(!contains_word("Bookshelf", "book"));
        assert!(!contains_word("my_book", "book"));
        assert!(!contains_word("", "book"));
    }
}
