# paysecure-qa – skill pack for the Paysecure AI gateway

Skills the Integration-automation launcher (and any other internal tool) uses through the
Paysecure AI gateway (claude-code-universal-client). This folder is the **source of truth**: it is
versioned with the launcher code that validates the answers, and deployed to the gateway as a pack.

| Skill                 | Used by                                   | What it does                                                      |
| --------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `generate-test-cases` | launcher → Test cases → Generate / Refine | writes and refines test cases as JSON rows of the upload template |

## Deploy to the gateway

Copy this folder into the gateway repo and rebuild (or mount `bundles/` and restart):

```bash
cp -R ai-skills/paysecure-qa <gateway-repo>/bundles/skills/
docker compose build && docker compose up -d
```

A session opened with `"skills": ["paysecure-qa"]` then lists `paysecure-qa__generate-test-cases`.
Refer to the skill by that full name – the gateway's seat account may have other skills with similar
names.

Until the pack is deployed the launcher still works: when the session does not list the skill it opens
a cheaper **chat** session and sends this same SKILL.md as the system prompt (`AI_GATEWAY_SKILLS=inline`
forces that mode).

## Adding a skill

1. New folder `<skill-name>/SKILL.md` with `name` and `description` front matter. The description says
   when to use it (e.g. "a message starting with TASK: <name>").
2. Keep live data out of the skill: the caller sends it per request (CONTEXT). The skill holds the
   rules, the judgement and the answer format.
3. Answer formats are JSON the caller validates; for anything refined over several turns use the
   `add` / `update` / `remove` change format of `generate-test-cases`, so state stays with the caller.
4. Redeploy the pack. Callers pick it up on their next session.

Ideas that fit this pack: `triage-failed-run` (report → likely cause, PGS vs PSP vs test),
`review-pgs-change` (a PGS diff → which categories and cases are affected).
