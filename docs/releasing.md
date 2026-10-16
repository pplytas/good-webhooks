# Release Good Webhooks

The first public alpha is [`0.1.0-alpha.1`](https://www.npmjs.com/package/good-webhooks/v/0.1.0-alpha.1). Its library manifest permits publication. Preparing or merging a candidate does not publish it. The root and documentation packages always remain private.

## Verify a candidate

Review the changelog, public compatibility policy, and migration instructions. Run the normal CI checks, the packed-consumer checks, and `pnpm test:operations` against a disposable PostgreSQL database. The operational rehearsal checks bounded recovery scenarios; it is not a capacity benchmark.

Require these main-branch checks before merging:

- `Verify (PostgreSQL 16)`
- `Verify (PostgreSQL 17)`
- `Better Auth storage adapters`
- `Package consumers`
- `Documentation`

After main CI passes, manually run `.github/workflows/release.yml` on `main`, enter the exact manifest version, and leave `publish` false. The workflow requires successful CI for that commit, checks that the version and `publishConfig.tag` agree (a pre-release channel such as `beta`, or `latest` for a stable `x.y.z` version), tests the archive in fresh consumers, audits runtime dependencies, and dry-runs npm publication. Download its `release-package` artifact. The run summary records the commit and archive SHA-256.

```sh
gh workflow run release.yml --ref main -f version=0.1.0-beta.1 -f publish=false
```

A dry run proves package preparation. It does not authenticate to npm or establish ownership of the package name.

## Approve the first publication

Registry publication is a separate decision. Before publishing, review the exact commit, archive, release notes, and npm account. The publication change removes `private` only from `packages/good-webhooks/package.json`. Verify its merged main commit through CI and the release dry run. Keep `publishConfig.tag` set to the current pre-release channel, or `latest` for a stable version; the workflow publishes with that dist-tag.

An npm registry 404 does not reserve the name or prove that npm will accept it. The initial release requires an authenticated npm account with the right to publish `good-webhooks`. Never publish a placeholder package to claim the name.

For the initial publication, use the downloaded verified archive after `npm login` and `npm whoami` confirm the intended account. npm may require an interactive two-factor check.

```sh
npm publish ./good-webhooks-0.1.0-alpha.1.tgz --ignore-scripts --access public --tag alpha
```

This command publishes publicly. Run it only after the publication decision. Local initial publication does not establish GitHub provenance. Once the package exists, configure trusted publishing for subsequent versions rather than storing an npm publishing token in GitHub.

## Configure trusted publishing

In the package's npm settings, add a GitHub Actions trusted publisher with these values:

| Setting              | Value                |
| -------------------- | -------------------- |
| Organization or user | `pplytas`            |
| Repository           | `good-webhooks`      |
| Workflow filename    | `release.yml`        |
| Environment          | `npm`                |
| Allowed action       | Direct `npm publish` |

Create the GitHub `npm` environment with a required maintainer reviewer and restrict it to `main`. The workflow grants OIDC permission only to the publish job, which downloads and publishes the already verified archive without running package lifecycle scripts. It uses the dist-tag from `publishConfig.tag` and requests provenance. A merge or tag push cannot trigger publication.

Follow npm's [trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/). New trusted publisher configurations currently expire if they do not complete a first successful publish within two days. Configure this close to the next approved release, then verify authentication and provenance from that actual run. Saving the configuration alone does not prove it works.

For a subsequent approved pre-release, update the package version and changelog in a PR, merge after CI, and dispatch the release workflow with the exact version and `publish` true. Review the environment approval against the workflow's commit. If npm publication fails or its outcome is uncertain, inspect the registry version before rerunning. npm versions are immutable.

## Verify and announce a release

Check the package version, dist-tag, contents, integrity, and provenance where applicable. Install `good-webhooks@<exact-version>` into a fresh consumer and verify the supported entry points. Confirm `alpha` resolves to the intended version. Publishing with `--tag alpha` does not update `latest`. Move `latest` only when the release decision explicitly approves that version for default installs.

On the first publication, npm also assigned `latest` to `0.1.0-alpha.1` despite `--tag alpha`, and rejected `npm dist-tag rm good-webhooks latest` with HTTP 400. This matches the [reported npm first-publication behavior](https://github.com/npm/cli/issues/8490). On 2026-10-12, the maintainer approved moving `latest` to `0.1.0-alpha.4` so default installs receive the supported alpha.

For an approved tag change, authenticate as the package maintainer, move the tag, then verify the registry and a fresh default install:

```sh
npm whoami
npm dist-tag add good-webhooks@0.1.0-alpha.4 latest
npm view good-webhooks dist-tags --json
```

Keep documentation explicit about pre-release status and use the channel tag (`@beta`) or an exact version in installation commands. Moving from `alpha` to `beta` started with `0.1.0-beta.1`; once it is published, move `latest` to it so default installs leave the alpha series. Moving a tag does not change the published archive or its README. Package README changes require a new release.

Create a GitHub prerelease named `v<version>` targeting the verified commit, with its changelog entry and installation command. Install commands in the docs name the channel tag; publish promptly after merging a channel change so the deployed docs do not point at a tag that has no versions yet. Link the release's compatibility and migration notes. Retain old versions so existing lockfiles continue to work; use npm deprecation messages for superseded or broken versions when needed.

## Promote to a stable version

The first stable release was `0.1.0` ([issue #22](https://github.com/pplytas/good-webhooks/issues/22)). To promote a pre-release line to a stable version, in the prepare PR set the package version to `0.1.0`, set `publishConfig.tag` to `latest`, date the changelog entry, and replace beta wording and `@beta` install commands with the plain package name. The release workflow accepts the stable version and publishes to `latest` directly, so no dist-tag move is needed afterwards. Create a normal (non-prerelease) GitHub release. Keep the `beta` tag on the last beta; do not delete pre-release versions.
