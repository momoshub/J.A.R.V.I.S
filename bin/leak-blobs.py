#!/usr/bin/env python3
"""Print, as UTF-8 text, what gitleaks cannot read in the blobs named on stdin.

bin/leak-scan.sh meta feeds this output to gitleaks. Two kinds of blob hide text:
- UTF-16, which reads as bytes with a NUL between characters. A blob with a byte
  order mark is decoded by it. With no mark, any blob holding a NUL is decoded as
  UTF-16LE and UTF-16BE, from byte 0 and from byte 1 (UTF-16 appended to an odd-length
  UTF-8 prefix starts at an odd offset), and all four are printed. The wrong ones
  decode to noise no rule matches.
- compressed files: zip (including .xlsx/.docx/.pptx), gzip, bzip2 and xz are
  unpacked, nested up to MAX_DEPTH, and each member is printed as text and run
  through the UTF-16 step. Unpacking stops at MAX_BYTES per blob, against zip bombs.
"""
import bz2
import gzip
import io
import lzma
import subprocess
import sys
import zipfile

MAX_DEPTH = 3
MAX_BYTES = 64 * 1024 * 1024


def utf16(data):
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        yield data.decode("utf-16", errors="replace")
    elif data.count(0) > 0:
        for start in (0, 1):
            part = data[start:]
            part = part[: len(part) // 2 * 2]
            for encoding in ("utf-16-le", "utf-16-be"):
                yield part.decode(encoding, errors="replace")


def bounded(stream):
    data = stream.read(MAX_BYTES + 1)
    return data[:MAX_BYTES]


def unpacked(data):
    """Members of a compressed blob, as (bytes) pieces; empty when it is not one."""
    try:
        if data[:4] == b"PK\x03\x04":
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for info in z.infolist():
                    if not info.is_dir():
                        with z.open(info) as f:
                            yield bounded(f)
        elif data[:2] == b"\x1f\x8b":
            yield bounded(gzip.GzipFile(fileobj=io.BytesIO(data)))
        elif data[:3] == b"BZh":
            yield bounded(bz2.BZ2File(io.BytesIO(data)))
        elif data[:6] == b"\xfd7zXZ\x00":
            yield bounded(lzma.LZMAFile(io.BytesIO(data)))
    except Exception as err:  # a damaged archive is reported, not fatal
        sys.stderr.write(f"leak-blobs: could not unpack a blob ({type(err).__name__})\n")


def texts(data, depth, inner):
    """Text to scan for one blob. inner: it came out of an archive, so its plain
    bytes are new to gitleaks too."""
    if inner:
        yield data.decode("utf-8", errors="replace")
    yield from utf16(data)
    if depth < MAX_DEPTH:
        for member in unpacked(data):
            yield from texts(member, depth + 1, True)


ids = [line.strip() for line in sys.stdin if line.strip()]
if not ids:
    sys.exit(0)
proc = subprocess.run(["git", "cat-file", "--batch"], input=("\n".join(ids) + "\n").encode(), capture_output=True, check=True)
out = proc.stdout
pos = 0
while pos < len(out):
    end = out.index(b"\n", pos)
    header = out[pos:end].split()
    pos = end + 1
    if len(header) < 3 or header[1] != b"blob":
        continue
    size = int(header[2])
    data = out[pos:pos + size]
    pos += size + 1
    for text in texts(data, 0, False):
        sys.stdout.write(text + "\n")
