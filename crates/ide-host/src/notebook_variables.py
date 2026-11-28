# Run silently on a notebook's kernel by the Jupyter Variables tool window. The IDE then
# evaluates `globals().pop("_openidea_variables")()` as a user expression, which also takes
# the function back out of the notebook's namespace. Same rows as the Python Console's.
def _openidea_variables():
    import base64
    import collections
    import json
    import reprlib
    import types

    shell = get_ipython()  # noqa: F821 -- defined in every IPython namespace
    short = reprlib.Repr()
    short.maxstring = short.maxother = 200
    limit = short.maxother
    items = 100
    containers = (dict, list, tuple, set, frozenset, collections.deque)

    def value_text(value):
        # reprlib shortens the exact builtin types itself; for anything else it builds the
        # full repr() and then cuts it. That is right for a subclass's own repr (a namedtuple,
        # an OrderedDict, a defaultdict), but costs seconds and gigabytes for a big one.
        kind = type(value)
        if isinstance(value, (str, bytes, bytearray)) and kind is not str and len(value) > limit:
            return repr(value[:limit]) + "..."
        if isinstance(value, containers) and kind not in containers and len(value) > items:
            return "<%s len=%d>" % (kind.__name__, len(value))
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
