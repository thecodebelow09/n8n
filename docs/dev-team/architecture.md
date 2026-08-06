# Dev Team automation architecture

GitHub is authoritative for requirements, state, reviews, and approvals. n8n orchestrates the lifecycle. A dedicated host runner performs allowlisted Git, Codex, validation, Docker-staging, and GitHub CLI operations.

## Safety boundaries

- The n8n container never receives arbitrary host-shell access.
- The runner accepts only predefined action names over a token-authenticated HTTP API.
- Issue text is treated as untrusted input.
- Validation retries require a changed diff and stop on a repeated failure signature.
- Staging deployment requires `human:staging-approved`.
- Merge requires `human:merge-approved` and can be disabled globally.
- GitHub issues and Project fields remain the durable source of truth.

## Workflow stages

1. Intake
2. Plan/specification check
3. Isolated worktree implementation
4. Deterministic validation with bounded repair
5. Adversarial review
6. Pull request creation
7. Human-gated staging
8. Human-gated merge
9. Project synchronization

## Production rule

The automation may prepare, test, review, and stage changes. Runtime/orchestration changes do not merge without an explicit human approval label.
