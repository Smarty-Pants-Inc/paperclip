# Seam register

This fork (`Smarty-Pants-Inc/paperclip`) tracks upstream `paperclipai/paperclip`. A
**seam** is a deliberate change to Paperclip's core that this fork carries because
Paperclip has no documented or existing way to do the job. Anything that Paperclip's
own features, settings, plugins, adapters or skills can do is built there instead,
not here. Our own extensions are built **on top of** a seam, never into it.

Every seam follows the `paperclip-extend` process:

1. **No existing way.** Record what was searched (docs, API reference, plugin SDK,
   skills, adapters, settings, roadmap, upstream issues and pull requests, source at
   the pinned commit) and why each candidate falls short.
2. **Existing seams first.** Extend or merge into a seam below before adding one.
3. **The Paperclip way.** Match Paperclip's plugin and extension shape (naming,
   configuration, packaging, permissions, docs and tests). Generalise where it costs
   little. Keep the core change as small as possible.
4. **Design review.** A design pair (designer and challenger) reviews the design
   before it is built. The record is linked from the seam's entry.
5. **Build** with Paperclip's own tests and docs, written as if offered upstream.
6. **Extensions** go on top of the seam.
7. **Independent check** on the real path.

Design records for a seam are kept in this repository under `doc/seams/`. Links to
`Smarty-Pants-Inc/smarty-dev` point to private planning issues that only the fork's
maintainers can open.

Each seam lives on its own branch, `seam/<name>`, kept rebased on upstream, and is
merged into this fork's `master`. Offering a seam upstream needs the product
owner's approval of the exact text.

## Seams

| ID | Seam | Status | Branch | Design and review | Upstream |
| --- | --- | --- | --- | --- | --- |
| S1 | Runner Pi configuration: Pi version, thinking levels, named Pi packages | design review | `seam/runner-pi-1.2` | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) | not offered |
| S2 | Manager interrupts or steers a report's run | planned | | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) | not offered |
| S3 | Fork pipeline: upstream sync, CI, release image | planned | | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) | not applicable |

S1's scope and whether it splits into separate seams are being settled by its design
review. This table is updated when the review result is recorded.

## Extensions on Paperclip's own surfaces (no seam)

| Extension | Surface | Tracking |
| --- | --- | --- |
| Dynamic budgets | Paperclip plugin | [smarty-dev#20052](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20052) |

## Entry template

For each seam, add a section with these headings:

- **Problem**: what an operator or agent cannot do today.
- **No existing way**: what was searched, with links, and why each candidate falls
  short.
- **Design**: the configuration, contract and files touched in core, with a link to
  the review record.
- **Extensions built on it**: what uses the seam.
- **Tests**: the tests that cover the seam.
- **Upstream**: offered or not, with a link.
