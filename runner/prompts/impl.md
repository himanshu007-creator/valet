You are researching one ticket in this repo. Do not modify any file outside `docs/impl/`.

Ticket {{TICKET_ID}}: {{TICKET_TITLE}}

{{TICKET_DESCRIPTION}}

Research the codebase for this ticket, then write `docs/impl/{{TICKET_ID}}.md` with exactly these sections:

## Summary
## Files involved
## Approach
## Risks
## Tests
## Open questions

At most one open question, phrased as a yes/no or A/B choice. If there are none, write "None."

When the file is written, print exactly one of these as the last line of your final message:
- `VALET_DONE` if there are no open questions
- `VALET_BLOCKED: <the question>` if there is one
