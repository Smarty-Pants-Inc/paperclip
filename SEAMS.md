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

## Upgrades

The fork follows every upstream stable release (the `latest` npm dist-tag and the
`vYYYY.MDD.P` release tags in `paperclipai/paperclip`):

1. A weekly routine opens an upgrade issue when upstream has a new stable release.
2. Each seam branch is rebased onto the new release tag, in the order of the table
   below. A conflict is fixed in the seam, not worked around in a new seam.
3. Each seam's own tests and its real-path check run again on the rebased build.
   A seam that no longer passes blocks the upgrade until it is fixed or dropped.
4. Before rebasing, each seam is checked against the release notes. If upstream now
   does the job, the seam is dropped and its extensions move to the upstream way.
5. `master` is rebuilt as the release tag plus the fork's own commits (this register
   and the rebased seams), and the fork's release image is built from it.

To keep upgrades cheap, a seam changes as few core files as it can, keeps its
configuration and contracts in one declaration, and puts everything else in plugins,
adapters or skills.

Until upstream's next stable release, the seam branches are based on upstream
`master`. From then on, they are based on release tags.

## Seams

| ID | Seam | Status | Branch | Design and review | Upstream |
| --- | --- | --- | --- | --- | --- |
| S1 | Runner Pi configuration: Pi version, thinking levels, named Pi packages | design review | `seam/runner-pi-1.2` | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) | not offered |
| S2 | Manager interrupts or steers a report's run | planned | | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) | not offered |
| S3 | Fork pipeline: upstream sync, CI, release image | planned | | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) | not applicable |

S1's scope and whether it splits into separate seams are being settled by its design
review. This table is updated when the review result is recorded.

## Upstream-pending carries

A **carry** is an open upstream pull request that this fork applies unchanged before
upstream merges it. A carry is not a seam: it has no design of our own. Each one is
cherry-picked with `-x`, keeps its original authors, and stays as its own group of
commits. When upstream merges the pull request, the next upgrade drops the group.
Each carry records its test result and whether it is deployed.

| ID | Upstream pull requests | Branch | Status | Evidence |
| --- | --- | --- | --- | --- |
| C1 | Pool starvation: [#18744](https://github.com/paperclipai/paperclip/pull/18744), [#17833](https://github.com/paperclipai/paperclip/pull/17833), [#18928](https://github.com/paperclipai/paperclip/pull/18928) (issue [#18700](https://github.com/paperclipai/paperclip/issues/18700)) | `carry/pool-starvation` on `canary/v2026.1111.0-canary.4` | Tested locally, not deployed. Pool size 10: the burst is accepted (80/80, against 0/80 without it). Pool size 40: no proven gain. `DATABASE_POOL_MAX=40` is used instead. | [smarty-dev#20045](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20045) |

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
