# Inline reasoning display

- Adds a per-device `reasoningDisplay` preference in localStorage (`fold` by default, `inline` opt-in) to the task-chat view.
- Inline mode keeps provider-authored reasoning in chronological transcript order. Tool/usage activity continues to use the existing fold; the preference does not change transcript or API data.
- Inline reasoning uses the existing reasoning Markdown renderer in a compact neutral, fully outlined surface (no one-edge accent stripe). Streaming content remains live; completed content is visible without disclosure. The same single-column block works at phone width.
- Tests verify default folding, inline ordering, and that tools remain grouped. Storybook gallery covers live inline reasoning at desktop and phone widths.
- Plugin render slot not selected: Paperclip has no transcript-item renderer slot, and a plugin would need a host seam to replace transcript rendering; this change stays within the existing host chat timeline and is smaller than introducing a new plugin contract.
