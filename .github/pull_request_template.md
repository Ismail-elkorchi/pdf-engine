## Summary
- [ ] Describe what changed and why.
- [ ] Confirm this description is historical, not aspirational.

## User-visible changes
- [ ] List externally observable behavior or interface changes.
- [ ] If no user-visible changes, explicitly state `None`.

## Evidence
- [ ] Paste commands run and summarize outputs.
- [ ] Include:
  - `npm run check`
  - `npm run build`
  - `npm run smoke:all`
  - `npm pack --dry-run` when packaging changed
  - `npx -y jsr publish --dry-run --allow-dirty` when JSR or publish workflows changed

## Risk and rollback
- [ ] List key risks introduced by this PR.
- [ ] List rollback strategy.

## Additional checklist
- [ ] PR title is a Conventional Commit title.
- [ ] Breaking change status evaluated.
- [ ] Release and triage labels applied or intentionally left unchanged.
- [ ] Docs are present tense and match current behavior.
