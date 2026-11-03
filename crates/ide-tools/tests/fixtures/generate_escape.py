"""Regenerate the malicious tar fixtures used by archive.rs tests (Python stdlib only)."""

import bz2
import io
import lzma
from pathlib import Path
import tarfile

archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode="w", format=tarfile.GNU_FORMAT) as tar:
    for name, target, data in [
        ("link", "../outside", b""),
        ("link/victim", None, b"replaced"),
        ("../escaped", None, b"escaped"),
        ("special", None, b"special"),
    ]:
        entry = tarfile.TarInfo(name)
        entry.mode = 0o7777
        if target:
            entry.type = tarfile.SYMTYPE
            entry.linkname = target
        else:
            entry.size = len(data)
        tar.addfile(entry, io.BytesIO(data))

for extension, compress in [("xz", lzma.compress), ("bz2", bz2.compress)]:
    Path(__file__).with_name(f"escape.tar.{extension}").write_bytes(compress(archive.getvalue()))
