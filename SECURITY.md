# Report a vulnerability

Report suspected vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/pplytas/good-webhooks/security/advisories/new). Include the affected commit or version, impact, and a minimal reproduction. Keep security reports out of public issues and pull requests.

## Response targets

One maintainer works on Good Webhooks part time, so these targets are ceilings, not averages.

- You get an initial response within 14 days of your report.
- A fix for medium or higher severity ships within 60 days of confirmation. Severity follows CVSS 4.0 or the maintainer's judgement.
- Lower severities are fixed in the next release.

The advisory credits you unless you decline.

## Supported versions

Security fixes reach the latest minor and the previous minor for three months after the next minor ships, as described in the [compatibility policy](https://good-webhooks.dev/docs/operations/compatibility#stability-policy). Alpha and beta versions receive no fixes. Upgrade guidance and affected versions belong in the advisory and release notes.

## Threat model

The [threats and defences table](https://good-webhooks.dev/docs/concepts/security#threats-and-defences) lists what the library defends against, what your application must enforce, and the test behind each claim.
