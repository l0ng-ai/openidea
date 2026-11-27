# Run silently on a notebook's kernel by the Jupyter Variables tool window; the IDE then
# evaluates `_openidea_variables()` as a user expression. Same rows as the Python Console's.
def _openidea_variables():
    import base64
    import json
    import reprlib
    import types

    shell = get_ipython()  # noqa: F821 -- defined in every IPython namespace
    short = reprlib.Repr()
    short.maxstring = short.maxother = 200
    rows = []
    for name, value in list(shell.user_ns.items()):
        if name.startswith("_") or name in shell.user_ns_hidden or isinstance(value, types.ModuleType):
            continue
        try:
            text = short.repr(value)
        except Exception as error:  # a broken __repr__ must not hide the other variables
            text = "<repr failed: %s>" % type(error).__name__
        rows.append({"name": name, "type": type(value).__name__, "value": text})
    rows.sort(key=lambda row: row["name"])
    # Base64 so the expression's text/plain (a str repr) needs no unescaping.
    return base64.b64encode(json.dumps(rows).encode()).decode()
