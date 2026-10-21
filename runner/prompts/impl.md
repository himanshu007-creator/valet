You are researching one ticket in this repo. Do not modify any file outside `docs/impl/`.

Ticket {{TICKET_ID}}: {{TICKET_TITLE}}

{{TICKET_DESCRIPTION}}

Research the codebase for this ticket — be decisive: read what you need, don't re-read files you've
already seen, and only reach outside the repo (web search/fetch) if something is genuinely
unanswerable from the code itself. Speed matters here as much as thoroughness. Then write
`docs/impl/{{TICKET_ID}}.md` with exactly these sections:

## Summary
## Files involved
## Approach
## Risks
## Tests
## Open questions

At most one open question — either a genuine content ambiguity, or something you'd want explicit
confirmation for before anyone acts on this doc (a destructive or irreversible choice, a real
tradeoff with no clearly-right answer). Phrase it as 2 to 3 numbered options, each **4 to 5 words
max**, hyper precise, plus always leave room for a custom answer. Example of the right length:
"(1) stream like now. (2) buffer instead. Or tell me what you'd prefer."
Do not write long sentences or explain the tradeoffs in the question itself — that's what the
Risks section is for. If there are none, write "None."

When the file is written, your final message must end with exactly one literal line, with the
real question substituted in (never print the word "question" as a placeholder):
- `VALET_DONE` if there were no open questions
- `VALET_BLOCKED: ` followed immediately by your actual question and its options
