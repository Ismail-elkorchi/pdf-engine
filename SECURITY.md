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

Include reproduction input, expected behavior, observed behavior, impact details, and runtime/version context.

## Current security posture

- The current public surface ships contracts and release scaffolding, not a finished parser.
- Future PDF inputs must be treated as untrusted by default.
- Resource limits, feature gating, and explicit diagnostics remain mandatory design constraints.

## Verification commands

```bash
npm run check
npm run build
npm run smoke:all
```
