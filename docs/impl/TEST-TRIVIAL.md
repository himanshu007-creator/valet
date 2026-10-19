# TEST-TRIVIAL: Valet repo file count check

## Summary

`ls` at the repository root lists **6** top-level entries:

```
package-lock.json
package.json
README.md
runner
server
web
```

Count = 6.

## Files involved

- Repository root only (read-only inspection). No source files are changed by this ticket.
- `docs/impl/TEST-TRIVIAL.md` (this file) is the sole artifact written.

## Approach

1. Run `ls` in the repo root of `valet` (working directory: `valet-test-trivial`).
2. Count the top-level entries returned.
3. Write the count under this Summary section.

## Risks

- Hidden entries (`.env`, `.git`, `.gitignore`) are excluded by plain `ls`; `ls -A` would yield 9. The literal command in the ticket is `ls`, so hidden entries are not counted.
- Creating `docs/` itself adds a top-level entry; the count was taken against the pre-existing tree, so the artifact directory is excluded.

## Tests

None. This is a read-only `ls` count with no code change to test.

## Open questions

None.
