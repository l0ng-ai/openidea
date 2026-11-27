# Run silently on a notebook's kernel by the Jupyter Variables tool window. The IDE then
# evaluates `globals().pop("_openidea_variables")()` as a user expression, which also takes
# the function back out of the notebook's namespace. Same rows as the Python Console's.
def _openidea_variables():
    import base64
    import json
    import reprlib
    import types

    shell = get_ipython()  # noqa: F821 -- defined in every IPython namespace
    short = reprlib.Repr()
    short.maxstring = short.maxother = 200
    limit = short.maxother

    def value_text(value):
        # reprlib shortens only the exact builtin types; for the rest it builds the full
        # repr() and then cuts it, which costs seconds and gigabytes for a big value.
        kind = type(value)
        if kind in (bytes, bytearray):
            text = repr(value[:limit])
            return text + "..." if len(value) > limit else text
        for base, shorten in (
            (dict, short.repr_dict),
            (list, short.repr_list),
            (tuple, short.repr_tuple),
            (set, short.repr_set),
            (frozenset, short.repr_frozenset),
        ):
            if isinstance(value, base) and kind is not base:
                return "%s(%s)" % (kind.__name__, shorten(value, short.maxlevel))
        return short.repr(value)

    rows = []
    for name, value in list(shell.user_ns.items()):
        if name.startswith("_") or name in shell.user_ns_hidden:
            continue
        try:
            if isinstance(value, types.ModuleType):
                continue
            kind = type(value).__name__
            text = value_text(value)
        except Exception as error:  # a broken __repr__ or __class__ must not hide the other variables
            kind, text = "?", "<unavailable: %s>" % type(error).__name__
        rows.append({"name": name, "type": kind, "value": text})
    rows.sort(key=lambda row: row["name"])
    # Base64 so the expression's text/plain (a str repr) needs no unescaping.
    return base64.b64encode(json.dumps(rows).encode()).decode()
