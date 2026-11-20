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
