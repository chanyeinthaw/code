# Release Sora

Sora versions start at `0.0.0` and are independent of upstream releases. This
repository holds only Sora's own version tags. Upstream tags are never fetched
(`remote.upstream.tagopt` is `--no-tags`) and must never be pushed here. The
release workflow does not calculate a version from Git history or run on a
schedule.

## Release

CI runs on pull requests and by hand, not on pushes. Run **CI** from GitHub
Actions on the commit you want to release and wait for it to pass. Then tag that commit and push the tag:

```sh
git tag v0.0.2
git push origin v0.0.2
```

A pushed tag that matches `v<major>.<minor>.<patch>` starts **Release**. If a
release fails, fix it by hand: re-run the failed jobs, or retag a fixed commit.
Run **Release** manually with a `version` to build downloadable workflow
artifacts without publishing anything.

The workflow runs CI again on GitHub-hosted runners, builds shared JavaScript once,
and builds these targets on Linux:

| Target              | CLI       | Electron                             |
| ------------------- | --------- | ------------------------------------ |
| Linux x64           | `.tar.gz` | AppImage and Debian package          |
| macOS Apple Silicon | `.tar.gz` | App bundle, finalized as ZIP and DMG |
| Windows x64         | `.zip`    | NSIS installer                       |

The Windows installer includes the Linux x64 CLI for WSL. Windows binaries are
currently unsigned. A Windows runner verifies the CLI built on Linux.

The macOS runner applies ad hoc signatures to the binaries built on Linux and
creates the final ZIP and DMG. It does not compile JavaScript, native helpers,
or CLI executables. No Apple signing credentials are required, and releases
are not notarized. macOS Gatekeeper may block downloaded apps until the user
explicitly allows them.

The Linux macOS cross linker uses a checksum-pinned macOS 14.5 SDK archive.
Apple's SDK license applies to its use.

## Publish

After the build and verification jobs pass, a tag run publishes the tagged
commit. The workflow creates a draft on the existing tag, uploads the final
artifacts and `SHA256SUMS`, then publishes it as the latest release. Publication
uses the same ad hoc macOS signing as build-only runs.

A tag run then publishes the `@satslab/sora` launcher to npm after the GitHub
release is available. Configure npm trusted publishing for this repository and
`.github/workflows/release.yml` first. The launcher downloads the matching CLI
from the GitHub release and verifies its checksum.

Marketing, hosted web deployment, relay deployment, mobile releases, AUR
publication, Discord announcements, and scheduled nightlies are disabled.
T3 Connect remains an external service. Builds load its existing public
configuration from `.env.example` without reading or deploying relay infrastructure.
