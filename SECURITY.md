# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | yes |
| latest `0.x` release line | yes |
| older `0.x` lines | no |

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Security Advisories:

`https://github.com/Ismail-elkorchi/pdf-engine/security/advisories/new`

When you disclose a vulnerability, include reproduction input, expected behavior, observed behavior, impact details, and runtime/version context. If GitHub Security Advisories is unavailable, open a private draft advisory as soon as access returns instead of filing a public issue.

## Disclosure expectations

- We aim to acknowledge a vulnerability report within 3 business days.
- We aim to complete initial triage within 7 calendar days.
- We aim to share a remediation plan or status update at least every 14 calendar days until the disclosure is resolved.
- Please avoid public disclosure until we confirm impact, affected versions, and a safe remediation path.

## Current security posture

- The current public surface ships contracts and release scaffolding, not a finished parser.
- Future PDF inputs must be treated as untrusted by default.
- Resource limits, feature gating, and explicit diagnostics remain mandatory design constraints.
- Hostile, malformed, and random byte inputs are part of the expected threat model.

## Verification commands

```bash
npm run check
npm run build
npm run smoke:all
npm run test:fuzz
```
