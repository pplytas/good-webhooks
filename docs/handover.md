# Maintainer handover

## Purpose

This page is for a second maintainer, or for anyone taking over if the current maintainer is unreachable. It lists what a release is, what runs on its own, what access a maintainer needs, and where everything lives. The [release guide](releasing.md) has the background on each release step.

## What a release is

1. Open a PR that bumps `version` in `packages/good-webhooks/package.json` and adds a dated changelog entry. `publishConfig.tag` must be `latest` for a stable version, or the channel (`alpha`, `beta`) for a pre-release.
2. Merge it once every check is green.
3. Wait for main CI to pass on the merge commit. The release workflow refuses a commit without a successful main CI run.
4. Run `pnpm --filter good-webhooks audit --prod` locally. The release workflow runs the same audit, and any advisory in a runtime dependency fails it.
5. Dispatch the release workflow. Its first job verifies the archive before anything is published, so a separate dry run (`publish=false`) is optional.

   ```sh
   gh workflow run release.yml --ref main -f version=<version> -f publish=true
   ```

6. Approve the `npm` environment on the run page (Review deployments), or from the CLI. The environment id is an integer, so pass it with `-F`. The publish job then publishes the verified archive through npm trusted publishing with provenance.

   ```sh
   gh api -X POST repos/pplytas/good-webhooks/actions/runs/<run-id>/pending_deployments \
     -F "environment_ids[]=23759315897" -f state=approved -f comment="Publish <version>"
   ```

7. Copy the changelog entry into a file and create the GitHub release on the verified commit. Add `--prerelease` for a release candidate.

   ```sh
   gh release create v<version> --target <full-commit-sha> --title v<version> --notes-file notes.md
   ```

8. Check the registry. npm can take a few minutes to list the version.

   ```sh
   npm view good-webhooks dist-tags
   ```

9. Move the [examples](../examples) and the [Playground](https://github.com/pplytas/good-webhooks-playground) to the new version the same day.

A merge or a tag push never publishes. The workflow accepts `x.y.z` and `x.y.z-(alpha|beta).n` today, so it must learn an `rc` channel before 1.0.0-rc.1.

## What is automated and what is not

These run without anyone:

- CI on every push to `main`, every pull request to `main`, and every Monday.
- CodeQL on pushes and pull requests to `main`, and weekly. OpenSSF Scorecard on pushes to `main`, and weekly.
- Dependabot updates for GitHub Actions and npm, weekly, plus vulnerability alerts.
- The weekly growth metrics snapshot.

These need a maintainer: dispatching the release workflow, approving the `npm` environment, and creating the GitHub release. The current maintainer runs them through agent sessions. A second maintainer runs the same commands by hand.

## What a second maintainer needs

- **npm**: publish rights on the `good-webhooks` package, so the trusted publisher keeps working and dist-tags can be moved.
- **GitHub**: write access to `pplytas/good-webhooks` and a place on the `npm` environment's reviewer list, so they can merge and approve a publish.
- **Ownership**: the repository belongs to a personal account, so only its owner can change branch protection or bypass it. A full handover transfers the repository to an organization or to the new maintainer.

Access to the Vercel project for good-webhooks.dev and the Railway project for the Playground is optional for releases.

## Where things live

| Item             | Location                               |
| ---------------- | -------------------------------------- |
| CI               | `.github/workflows/ci.yml`             |
| Release workflow | `.github/workflows/release.yml`        |
| Changelog        | `CHANGELOG.md`                         |
| Roadmap          | `docs/roadmap.md`                      |
| ADRs             | `docs/adr/`                            |
| Docs site source | `apps/docs/content/docs/`              |
| Examples         | `examples/`                            |
| Playground       | [good-webhooks-playground][playground] |
| Security policy  | `SECURITY.md`                          |

[playground]: https://github.com/pplytas/good-webhooks-playground

## If the maintainer is unreachable

- The last release stays installable from npm. Published versions are immutable.
- `main` stays protected, so nothing merges until the required checks pass.
- Whoever holds npm publish rights on `good-webhooks`, write access to the repository, and a place on the `npm` reviewer list can release, following the steps above.
- The repository stays public under the MIT license, so anyone can fork it.
