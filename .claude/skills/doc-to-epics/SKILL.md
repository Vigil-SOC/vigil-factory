---
name: doc-to-epics
description: Turn a product or design document into factory inputs on the target repo — replies on the epics it revises and new epics for the directions it adds — so the factory's groomer can settle the decisions and write the children. Use when someone shares a design doc, product recommendation, roadmap, or plan revision and asks to feed it to the factory, file epics for it, or groom it from a product perspective.
---

# doc-to-epics

The factory consumes **direction**, not documents. A direction is a capability that
should become true and why. An epic is one direction, filed as an issue with the repo's
epic label; the groomer (see `README.md`, *Epics: where direction comes from*) settles
its decisions against the code and writes the children. A revision of a document is a
**reply on the epics it changes**, never a new epic and never a re-filed one.

This skill is the repeatable path from a document to those two things. It drafts first
and posts only on confirmation; posting is outward-facing.

## Inputs

- The document: a URL, or a local path. Epics **link** the document and never paste it
  (agents get links, not excerpts). A local file is fine for drafting; before filing, ask
  where it will live and use that URL. Do not publish it yourself.
- `factory.config.json` in this repo: `repo`, `labels.epic`, `labels.groomed`,
  `labels.needsWork`, `groom.principlesFile`. Everything below is relative to that repo.

## Steps

1. **Load the standard.** Read the principles file and the README's epic section. The
   groomer will judge the epics against these; the drafts should already speak their
   language (what becomes possible, decisions with defaults and reversal costs, what pulls
   against which principle, what only a human may decide).

2. **Inventory the epics that exist.**
   ```
   gh issue list -R <owner/name> --label <labels.epic> --state open --json number,title,url,body,labels
   gh api repos/<owner/name>/issues/<n>/comments --jq '.[] | select(.body | test("<!-- factory-groom")) | .body'
   gh issue list -R <owner/name> --state open --search "Part of #<n>" --json number,title,labels
   ```
   For each epic keep: its record (the latest `🏭 Factory groom` comment — the numbered
   decisions are what a reply may name), its open children and their verdicts.

3. **Read the document and split it into directions.** Keep only what says what should
   become true and why. Set aside, and say you set aside: schedules and day plans, owner
   assignments and division of labor, competitive reviews, org design, anything the
   document itself marks as human-only work, and anything for a repo the factory does not
   target. Those are not epics. A document may yield several directions or none.

4. **Map each direction.**
   - Same capability or seam as an existing epic → a **reply** on that epic.
   - Otherwise → a **new epic**.
   - A direction that is a child-sized change of an existing epic is still a reply: the
     groomer writes children, the human does not.

5. **Draft to a file** next to the document (`<doc-name>-factory-inputs.md`) and show it.
   Also collect, without pursuing them, anything you can verify in one look that the
   document gets wrong about the code or the factory itself; the user decides whether to
   send that back to the author.

   *Reply on an epic* — addressed to the groomer and the author, linking the revision:
   - what the revision changes relative to the record, one numbered item each, each naming
     the decision in the record it touches (or saying it touches none and where it fits);
   - which of those are asks to reverse a decision, in so many words, and which are
     clarifications the record already covers. Unnamed decisions stand — that is the
     ratchet the groomer applies on a re-review;
   - one line asking the groomer to re-review with the revision in view.

   *New epic* — title starting `Epic:`; labels: the epic label plus the repo's own area
   labels that fit; body of four short parts, in the repo's issue style:
   - **What becomes possible** that is not possible now, with the current code named
     where the document names it;
   - **Decisions to settle**, each with the document's proposed default when it has one;
   - **Where it pulls against the principles**, by principle, so the groomer settles it
     in the open rather than discovering it;
   - **Human-only decisions**: irreversible, legal or licensing, or widening what the
     system may do unattended. Expect these to come back as needs-work naming them
     unless the epic answers them.
   Do not write children. Do not paste the document. Keep it short; the groomer reads the
   document and the code itself.

6. **Confirm, then post.** Show the drafts and wait for a yes. Then:
   ```
   gh issue comment <n> -R <owner/name> --body-file <reply.md>
   gh issue create -R <owner/name> --title "Epic: …" --label <labels.epic> --label <area> --body-file <epic.md>
   ```
   A reply makes the epic's verdict stale (the fingerprint covers human comments) and it
   is groomed again on the next tick; its children follow. A new epic is groomed on the
   next tick ahead of everything else. Nothing else is needed; `npm run factory -- groom`
   runs it now instead of waiting for the schedule.

7. **Report** the URLs posted, what was set aside and why, and any premise the document
   got wrong. Append the drafts file location.

## Rules

- One epic per direction. A plan document is not an epic; a "45 issues in two days" plan
  is the failure mode this skill exists to prevent.
- A revision is a reply. Never file a second epic for a direction that has one, and never
  edit an epic's description to match a new revision — the record and its children hang
  off the reply thread.
- Never file children. The groomer files them against the code as it stands.
- Never paste document text into an issue. Link it.
- Post nothing without confirmation.
