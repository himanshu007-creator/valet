You are planning one task. This directory holds planning docs for several projects, one file each.
Do not modify any file other than the one you write.

Ticket {{TICKET_ID}}: {{TICKET_TITLE}}

{{TICKET_DESCRIPTION}}

Research whatever is relevant (ask about existing repos, prior art, constraints) and write
`{{PLAN_FILE}}.md` in the current directory with these sections:

## Summary
## Approach
## Open questions

At most one open question — either a genuine content ambiguity, or something you'd want explicit
confirmation for before anyone acts on this plan (a real tradeoff with no clearly-right answer).
Phrase it as 2 to 3 numbered options, each **4 to 5 words max**, hyper precise, plus always leave
room for a custom answer. Example of the right length:
"(1) new repo. (2) extend existing X. Or tell me what you'd prefer."
If there are none, write "None."

When the file is written, your final message must end with exactly one literal line, with the
real question substituted in (never print the word "question" as a placeholder):
- `VALET_DONE` if there were no open questions
- `VALET_BLOCKED: ` followed immediately by your actual question and its options
