# Report a vulnerability

Report suspected vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/pplytas/good-webhooks/security/advisories/new). Include the affected commit or version, impact, and a minimal reproduction. Keep security reports out of public issues and pull requests.

## Response targets

One maintainer works on Good Webhooks part time, so these targets are ceilings, not averages. They apply to reports against [supported versions](#supported-versions).

- You get an initial response within 14 days of your report.
- A fix for medium or higher severity ships within 60 days of confirmation. Severity follows CVSS 4.0 or the maintainer's judgement.
- Lower severities are fixed in the next release.

The advisory credits you unless you decline.

## Supported versions

| Version               | Fixes              |
| --------------------- | ------------------ |
| Latest minor          | All fixes          |
| Previous minor        | Security, 3 months |
| Last 1.x, after 2.0.0 | Security, 6 months |
| Alpha, beta, and rc   | None               |

The windows start when the next minor or major ships. 1.0.0 has not shipped yet.

The [compatibility policy](https://good-webhooks.dev/docs/operations/compatibility#support-windows) is the source for these windows. Upgrade guidance and affected versions belong in the advisory and release notes.

## Automated checks

- Dependabot opens dependency updates weekly and raises vulnerability alerts.
- CodeQL scans every push and pull request to `main`, and runs weekly.
- OpenSSF Scorecard runs on every push to `main` and weekly.
- Releases publish through npm trusted publishing with provenance, so no npm token is stored.
- Workflows pin every action to a full commit SHA.

## Threat model

The [threats and defences table](https://good-webhooks.dev/docs/concepts/security#threats-and-defences) lists what the library defends against, what your application must enforce, and the test behind each claim.
