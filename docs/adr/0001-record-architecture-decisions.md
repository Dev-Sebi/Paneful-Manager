# ADR 0001: Record architecture decisions

- Status: accepted
- Date: 2026-10-27

## Context

Agent Hub is built in parallel tasks by several contributors. Decisions made in one task (process model, protocol, security) constrain many others and must not be re-argued or silently changed.

## Decision

Architecture decisions are recorded as short Markdown ADRs in `docs/adr/`, numbered `NNNN-kebab-title.md`, with the sections Status, Context, Decision, Consequences and Alternatives considered. Status is one of `proposed`, `accepted`, `superseded by NNNN`. An accepted ADR is not edited in substance; a change gets a new ADR that supersedes it. `docs/architecture.md` describes the current design and links the ADRs.

## Consequences

- Reviewers can point to an ADR instead of repeating the reasoning.
- Changing a recorded decision costs one extra file, which is intended.

## Alternatives considered

- Decisions only in `architecture.md`: the reasoning and rejected options get lost when the document is updated.
- Decisions in issues or pull requests: not versioned with the code, hard to find.
