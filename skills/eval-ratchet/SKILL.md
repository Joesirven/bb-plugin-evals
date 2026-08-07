---
name: eval-ratchet
description: Run, score, and interpret the eval ratchet. Use when scoring a session against sealed fixtures, when proposing an amendment to an AGENTS.md or a definition of done, or when asked whether a context change actually improved agent output. Also use before editing shared conventions, to check what the ratchet has already flagged.
---

# The eval ratchet

A ratchet claims monotonic improvement. You can only claim that if you measure
against something that does not move. That is what this is.

## The two invariants

**1. Proposals are never self-applied.** This plugin records a proposed
amendment and files it as a task. It has no apply operation — there is no code
path that writes to a target document. A human copies the amendment in. If you
are an agent reading this: do not "helpfully" apply a proposal. Recording it is
the whole job.

**2. Fixtures are sealed.** Every fixture set is hashed by path and content.
If the fixtures drift, `bb evals run start` REFUSES rather than scoring. A loop
that can edit its own test set optimizes against a moving target and reports
progress that is not real.

## The two passes

1. **Deterministic** — every scenario is scored by the existing checks. Anything
   caught here never reaches the judge; there is no value in an LLM
   re-diagnosing a format violation a regex already caught.
2. **Judge** — only scenarios the deterministic layer *passed* go to the judge.
   Those are where a hidden quality gap might still be present.

Judge rules, carried over from Meadow's `01-PERSONAS/judge.md`:

- **Order-randomized.** Position must never predict which candidate is graded
  first. Record the position with `--position`.
- **Never self-judging.** A judge never grades a candidate it authored. It
  refuses and logs instead.
- **Cheap tier.** The router's cheap tier, never a frontier model.
- **Cross-provider where possible.** Different models from one provider is weak
  independence; different *providers* is strong. Record with `--judge-provider`.

## Workflow

```bash
# One-time: seal a fixture set
bb evals fixtures seal ratchet-core --path ~/dev/meadow/tools/ratchet_fixtures
bb evals fixtures seal ratchet-holdout --path ~/dev/meadow/tools/holdout --holdout

# Check for drift without running
bb evals fixtures verify ratchet-core

# A run
RUN=$(bb evals run start ratchet-core --context-version "agents-md@2026-08-06" --json | jq -r .runId)
bb evals run score $RUN --scenario vacuous-but-valid --layer deterministic --passed true
bb evals run score $RUN --scenario vacuous-but-valid --layer judge --passed false \
  --judge-provider codex --tier cheap --position 3 --detail "asserts completion without evidence"
bb evals run finish $RUN

# A traced failure becomes a proposal, then a task
PROP=$(bb evals propose $RUN --scenario vacuous-but-valid \
  --failure "The session claimed done with no evidence any check ran." \
  --amendment "Add to the definition of done: name the command run and paste its exit status." \
  --target "~/.bb/AGENTS.md" --json | jq -r .id)
bb evals file $PROP

# Did it help?
bb evals trend ratchet-core
```

## Holdout sets

Seal at least one fixture set with `--holdout`. The ratchet never proposes
against it. If pass rate climbs on the working set but stays flat on the
holdout, the loop is overfitting to the fixtures it can see — that gap is the
single most useful number this system produces.

## Reading a trend

`bb evals trend <set>` plots judge pass rate per run against the context version
in effect. A rise right after adopting a proposal is the evidence the ratchet
exists to produce. A rise with no adopted proposal in between is noise, drift,
or a judge change — check `bb evals runs` for refusals before believing it.
