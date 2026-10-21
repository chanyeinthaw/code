# Release Sora

Sora versions start at `0.0.0` and are independent of upstream releases. The
release workflow does not fetch upstream tags, calculate a version from Git
history, or run on a schedule.

## Build a release

Run **Release** from GitHub Actions on the intended commit or branch. Set
`version` to an exact stable version. Leave `publish` and `publish_npm` off to
build downloadable workflow artifacts without publishing a release.

The workflow runs CI on GitHub-hosted runners, builds shared JavaScript once,
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

Enable `publish` to create `v<version>` in this repository after the build and
verification jobs pass. An existing tag is rejected. The workflow creates a
draft, uploads the final artifacts and `SHA256SUMS`, then publishes it as the
latest release. Publication uses the same ad hoc macOS signing as build-only runs.

Enable `publish_npm` as well to publish the `@satslab/sora` launcher after the
GitHub release is available. Configure npm trusted publishing for this repository
and `.github/workflows/release.yml` first. The launcher downloads the matching
CLI from the GitHub release and verifies its checksum.

Marketing, hosted web deployment, relay deployment, mobile releases, AUR
publication, Discord announcements, and scheduled nightlies are disabled.
T3 Connect remains an external service. Builds load its existing public
configuration from `.env.example` without reading or deploying relay infrastructure.
