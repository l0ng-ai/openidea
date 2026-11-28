# Renders the reStructuredText on stdin (argv[1] names the file in messages) to the HTML body of its
# preview on stdout. Nothing is read past the document: no included files, raw HTML, URLs
# or docutils.conf, and no image is opened to size it. Problems show inline.
import sys

try:
    import docutils.core
except ImportError:
    sys.stdout.write("no-docutils")
    sys.exit(3)

source = sys.stdin.buffer.read().decode("utf-8", "replace")
parts = docutils.core.publish_parts(
    source,
    source_path=sys.argv[1],
    writer_name="html5",
    settings_overrides={
        "_disable_config": True,
        "file_insertion_enabled": False,
        "raw_enabled": False,
        "image_loading": "link",
        "embed_stylesheet": False,
        "math_output": "MathML",
        "syntax_highlight": "none",
        "report_level": 2,
        "halt_level": 5,
        "warning_stream": False,
        "traceback": True,
    },
)
sys.stdout.buffer.write(parts["html_body"].encode("utf-8"))
