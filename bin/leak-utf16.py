#!/usr/bin/env python3
"""Print, as UTF-8, every blob named on stdin that is UTF-16 text.

gitleaks reads a UTF-16 file as bytes with a NUL between every character, so no
rule matches it. bin/leak-scan.sh meta feeds the decoded text to gitleaks instead.
UTF-16 is recognised by its byte order mark, or, with no mark, by NUL bytes in every
other position of the start (ASCII text written as UTF-16LE or BE).
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
    head = data[:64]
    encoding = None
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        encoding = "utf-16"
    elif len(head) >= 8 and all(b == 0 for b in head[1::2]) and any(head[0::2]):
        encoding = "utf-16-le"
    elif len(head) >= 8 and all(b == 0 for b in head[0::2]) and any(head[1::2]):
        encoding = "utf-16-be"
    if encoding:
        sys.stdout.write(data.decode(encoding, errors="replace") + "\n")
