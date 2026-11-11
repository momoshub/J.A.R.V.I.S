#!/usr/bin/env python3
"""Print, as UTF-8, every blob named on stdin that is UTF-16 text.

gitleaks reads a UTF-16 file as bytes with a NUL between every character, so no
rule matches it. bin/leak-scan.sh meta feeds the decoded text to gitleaks instead.
A blob with a byte order mark is decoded by it. With no mark, any even-length blob
holding a NUL is decoded both as UTF-16LE and as UTF-16BE, and both are scanned.
"""
import subprocess
import sys

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
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        sys.stdout.write(data.decode("utf-16", errors="replace") + "\n")
    elif len(data) % 2 == 0 and data.count(0) > 0:
        # no mark: read it both ways rather than guess the byte order. Where the NULs
        # fall says too little (U+3000, U+4E00, U+AC00 and emoji surrogates put them on
        # the "wrong" side), and the wrong order decodes to CJK noise no rule matches
        for encoding in ("utf-16-le", "utf-16-be"):
            sys.stdout.write(data.decode(encoding, errors="replace") + "\n")
