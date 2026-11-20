# Reader-local times in Markdown

System notes that identify a saved message use this ordinary Markdown link:

```markdown
[2026-11-20T13:04:00.000Z](#paperclip-time=2026-11-20T13:04:00.000Z)
```

The label and fragment carry the same canonical UTC ISO timestamp (including
milliseconds). MarkdownBody renders the reserved `#paperclip-time=` fragment as
a semantic `time` element, not a clickable link. Its text uses the reader's
browser-default locale and time zone via `Intl.DateTimeFormat`; its title shows
the full local date, time and zone. For this instant an en-US reader in
America/New_York sees **8:04 AM**, and a de-DE reader in Europe/Berlin sees
**14:04**. Neither the server's time zone nor the author's time zone determines
what another reader sees.

Plain-text, copied Markdown and other Markdown renderers retain the ISO label,
so their fallback is unambiguous even without this extension. No raw HTML or
custom URL scheme is needed. Invalid/noncanonical timestamps remain ordinary
links; inline and fenced code remain literal. This does not reinterpret old
bare HH:mm notes: their original time zone was not stored and cannot safely be
inferred.

The unanswered-message naming prefix, the >=24-hour note, and setup's `since`
text all emit this form. Their first words, notice identity, remedies, card
retirement/restoration and scheduling rules are unchanged.

## Onboarding and Slack Board mirror reachability

The saved-message recovery notes are system issue comments, created with an
empty actor. Their `authorAgentId` and `authorUserId` are null. OnboardingChat
loads those issue comments and passes their bodies unchanged to MarkdownBody,
so the same reader-local rendering applies there. Its link-to-label replacement
is restricted to agent-authored comments; that branch does not describe these
system notes. Do not reproduce a system-note failure by changing its author to
an agent in the fixture.

`mirrorSlackBoardComment` is the authenticated human Board-send path, not a
system-note or agent-note mirror. It rejects non-user author types before
reading bindings or creating a publication. The issue-comment caller is also
gated to a user actor and an explicit mirror option. Preserve that publication
boundary: adding time formatting must not make internal system notes eligible
for Slack delivery. The existing safe publication projection also removes
non-public Markdown hrefs, so `comment.body` interpolation is not by itself
proof that literal `#paperclip-time` markup reaches Slack.

The real OnboardingChat jsdom rows in `OnboardingChat.test.tsx` exercise all three
system-note forms. `slack-board-messages.note-time.test.ts` exercises the real
mirror and records rejected system/agent notes alongside an authenticated human
positive control. These rows are already green at `1bf1d2a8`; they do not establish
a new red-to-green product repair.

For a separately authorized Slack surface that can publish these tokens, Slack's
[date-formatting contract](https://docs.slack.dev/messaging/formatting-message-text/#date-formatting)
is `<!date^EPOCH^{date_short_pretty} {time}|ISO fallback>`. Slack uses each
reader's device time zone. The example instant above is epoch `1795179840`.
This format is not emitted by the system-note Board mirror, because that path
rejects the note entirely.
