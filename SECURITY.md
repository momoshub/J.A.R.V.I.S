# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), or contact the maintainers directly. Include what you found, how to reproduce it, and the impact. We will reply as soon as we can.

If you spot a leaked secret, personal data or an internal name in the repo or its history, report it the same way so it can be removed and rotated.

## Leak guard

Contributions are scanned by gitleaks in CI and, when you enable the local hook with `bun run hooks`, before every push. See "Keeping private data out of the repo" in the README. Use made-up values in tests and examples.

Commit author, committer and tagger identities and `Co-authored-by`/`Signed-off-by` trailers (names and emails, work addresses included) are not scanned: they are public on any git host, and the existing history keeps them as an accepted exception rather than being rewritten.
