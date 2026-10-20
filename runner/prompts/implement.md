You are implementing one ticket for real, in this repo, on the branch already checked out here.
A research pass already happened: read `docs/impl/{{TICKET_ID}}.md` first — it has the summary,
files involved, approach, risks and tests. Follow it. Do not modify `docs/impl/{{TICKET_ID}}.md`
itself.

Ticket {{TICKET_ID}}: {{TICKET_TITLE}}

Make the real code changes the doc describes. Run the existing test suite (or linter/build,
whatever this repo actually has) before considering it done — do not claim success without
running something that would catch a broken change. Commit your work as you go.

At most one open question, only if something is genuinely ambiguous or risky enough to need
your confirmation (not for routine implementation choices already covered in the doc). Phrase
it as 2 to 3 numbered options, each **4 to 5 words max**, hyper precise, plus always leave room
for a custom answer. If there are none, write "None."

When you are done (or blocked), your final message must end with exactly one literal line,
with the real question substituted in (never print the word "question" as a placeholder):
- `VALET_DONE` if the implementation is complete and verified
- `VALET_BLOCKED: ` followed immediately by your actual question and its options
