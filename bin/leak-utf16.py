#!/usr/bin/env python3
"""Print, as UTF-8, every blob named on stdin that is UTF-16 text.

gitleaks reads a UTF-16 file as bytes with a NUL between every character, so no
rule matches it. bin/leak-scan.sh meta feeds the decoded text to gitleaks instead.
UTF-16 is recognised by its byte order mark, or, with no mark, by its NUL bytes all
falling on one side (odd positions for LE, even for BE), whatever the script.
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
    encoding = None
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        encoding = "utf-16"
    else:
        # where the NULs fall, not how many: UTF-16 puts them on one side only (LE odd,
        # BE even) whatever the script, a binary file has them on both. 90%, not all: an
        # emoji's low surrogate can put a NUL on the other side
        odd_nul = data[1::2].count(0)
        even_nul = data[0::2].count(0)
        total = odd_nul + even_nul
        if total >= 4 and len(data) % 2 == 0:
            if odd_nul / total >= 0.9:
                encoding = "utf-16-le"
            elif even_nul / total >= 0.9:
                encoding = "utf-16-be"
    if encoding:
        sys.stdout.write(data.decode(encoding, errors="replace") + "\n")
