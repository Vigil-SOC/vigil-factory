# Product-direction principles

The standard the target codebase is held to. Grooming applies these to an issue
before any agent implements it. They are about **what to build** — not how to
write the code, and not what the implementer needs to know. Coding-level
direction reaches the implementer through the grooming notes on the issue; these
principles do not.

## What Vigil is

Direction is judged against this section before anything else in this file. An
epic that breaks one of these commitments is needs-work however well it argues,
and no child may break one on its epic's behalf. A direction that is merely new
is not thereby wrong; the question is whether Vigil does SOC work better with it.

- **An open-source AI SOC.** Agents that triage, investigate, hunt, and respond
  to security signal, on infrastructure the customer owns, under Apache 2.0.
  Direction that makes Vigil better at that work is in scope. Direction that
  makes it a general agent platform, a SIEM, a data lake, or a chat product is
  not, however adjacent, and an epic that needs Vigil to become one of those
  first is needs-work.
- **Any model, no allegiance.** Every model call goes through the Bifrost
  gateway, and commercial and local models are peers: Anthropic, OpenAI,
  Google, or an Ollama model on the operator's own hardware. Nothing may depend
  on one vendor's API, model family, or feature. A capability that works on one
  provider only is a defect, not a first step, and "the default model does X"
  is not a reason to build on X.
- **Complete where the customer runs it.** Vigil works self-hosted, offline,
  and air-gapped with local inference. A hosted service, a vendor account, or
  an outbound connection is opt-in, and the product is whole without it. LogLM
  pairs with Vigil and enriches it; Vigil is complete without LogLM.
- **Autonomy is the goal.** Vigil is meant to run the SOC, not to assist a
  person running it. Under the ceiling its operator has set it acts without
  asking, and making an action safe and observable beats putting a person in
  front of it. Where that ceiling sits by default, and how far an operator may
  raise it, is product direction like any other: weigh it carefully against
  what Vigil is, and settle it.
- **Extension is the open standard.** Tools reach agents as MCP servers the
  operator configures. A vendor-specific code path where an MCP server would do
  is the wrong shape.

## Bloat is the default failure mode

The most likely thing to go wrong is not a bug. It is another feature nobody
needed, wired into everything, that now has to be maintained forever. Agents
produce plausible code cheaply, and the accumulated cost of that is a codebase
whose surface area no longer matches its value.

- An issue that adds a capability must say what becomes possible that was not
  possible before. "Consistency", "completeness", and "future flexibility" are
  not answers.
- Deleting code, collapsing two mechanisms into one, or removing a layer is
  worth more than an equivalent amount of new code.
- If a change needs a new module, a new config surface, and a new abstraction to
  connect them, it is almost certainly too large or the wrong shape.

## Every abstraction must fight for its life

Sprawl is this codebase's standing defect, not a hypothetical one: the same
concept is modeled several times, in different layers, in different stacks, and
each layer exists mostly to hand work to the next. Every new interface, base
class, wrapper, adapter, registry, manager, factory, or config layer adds to
that, and the burden is on the issue to justify it.

- An indirection with one caller is not an abstraction, it is a detour. Inline
  it. Two real call sites that exist today can justify one; an anticipated
  second caller cannot.
- Generalize only over cases that are actually in front of you. Parameterizing
  for a future shape is how a layer that nobody needed gets in.
- If an issue introduces a concept, name the single place it lives. The same
  concept modeled in two layers is a defect, and an issue that adds the second
  model must say how the first one dies.
- Prefer a longer concrete function to a short one plus three types plus a
  dispatch table. Layers are not free structure; they are the thing that has to
  be read and kept in sync.
- Removing a layer, collapsing two objects into one, or deleting a type is
  first-class work here, not cleanup to do later.

## Trust the agent; do not build the workflow

State-of-the-art agents do not need to be told how to work. Prescription is the
main way this codebase gets worse.

- Do not build orchestration that boxes an agent into fixed steps, forced output
  schemas, or handoffs between roles when one capable agent with the right tools
  would do the same job.
- Do not hand-roll agent loops, retry ladders, planner/executor splits, or
  scratchpad protocols. That is not valuable software; it is scaffolding around a
  capability the model already has.
- Prefer giving an agent a tool and a clear goal over giving it a procedure.
- Deterministic checks on what an agent *produces* are tools, and welcome: a
  lint that rejects a rule, a replay of a candidate against captured data, a
  test. Deterministic sequencing of what an agent *does* is not: a controller
  that runs plan, then execute, then validate, with a repair loop bounded by a
  counter, is the agent's judgment reimplemented badly. Each new model makes the
  second kind of code worse relative to the alternative and leaves the first
  kind exactly as useful as it was. Build the check; do not build the schedule.

## Do not reinvent what exists

- Before an issue proposes new machinery, it must say what was considered and
  why it does not fit — a library, a platform primitive, or code already in this
  repo.
- Two mechanisms doing the same thing is a defect, not a migration path. An
  issue adding a second one must say how the first one dies.

## Open standards over bespoke glue

Reach for the shared standard before the custom integration.

- MCP servers, agent plugins, and the `AGENTS.md` / `CLAUDE.md` conventions are
  the extension points. A new capability should usually arrive as a plugin or an
  MCP server — not a hardcoded call site plus a custom skill plus a chain of glue
  holding them together.
- A custom protocol between our own components needs a reason that an existing
  standard could not satisfy.

## Gates cost more than they protect

- A check that cannot fail in practice, or whose failure everyone routes around,
  is theater. It carries real maintenance cost and buys nothing.
- Approval steps, flags that are never flipped, and defensive layers that
  re-validate what the caller already validated are all in this category.
- Real guardrails — resource ceilings, blast-radius limits, an audit trail — are
  worth their cost. Ceremony is not.
- Autonomy is the direction of travel: the platform should be able to act on its
  own. Prefer making an action safe and observable to putting a human in front of
  it.

## Applying this to an issue

First ask whether there is a correct change here that one PR can land. It may be
narrower than what the issue asks for; if so, that narrowed change is the thing
to build, and the rest is named and left out.

An issue is not ready when there is no such change — when it pulls against the
above, when its premise is already false in the code, or when it is too large
with no smaller correct piece inside it.

Product direction enters through epics, and only through epics. An issue that
is a direction rather than a PR is an epic whether or not it was filed as one:
the groomer says so and the factory labels it. An epic is groomed as a
direction, not a PR: the question is whether it is worth building toward —
against *What Vigil is* first — and whether its shape-changing decisions can be
settled, and settling them is the groomer's job, not a list of questions handed
back. Pick the
default that proves the seam with the least new machinery, say why, and say
what it would cost to reverse. Hold an epic back only for a decision that
genuinely needs a person: one that is irreversible, or carries legal or
licensing exposure. A groomed epic's decisions are the premise its children inherit.
When grooming a child, do not re-ask whether the capability is worth having or
whether its concepts should exist; judge it on whether it is one correct PR
toward the epic, against every other principle here, and follow the decisions
the epic's groom recorded. An epic that is not groomed lends its children
nothing: a child whose point depends on it is needs-work, blocked on the epic.
A human who disagrees with a settled direction replies on the epic, and it is
groomed again with that reply in view. That is the veto; nothing waits for an
approval that was not asked for.

Vagueness is not one of those reasons. The implementer is a capable agent: it
chooses names, payloads, signatures, and structure, and does not need the issue
to have decided them. Ask whether the *product* decision has been made — what
should become true, and whether it is worth doing — not whether the issue is
precise. Missing detail is a reason to reject only when filling it in would mean
deciding something that binds work beyond this PR — a schema others must join
to, a contract another component is already written against — and the issue
gives no basis for that decision.

Cite the code. A rejection that cannot point at a file is a guess. And do not
invent a small task to rescue a bad issue: if the narrowed change is not worth
doing on its own, it is busywork, and busywork is the failure mode at the top of
this document.
