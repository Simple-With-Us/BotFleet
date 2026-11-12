# cloudflared release provenance

BotFleet stages the official `cloudflared` 2026.10.3 executable as a separate
process.  The binaries come from Cloudflare's official GitHub release:

<https://github.com/cloudflare/cloudflared/releases/tag/2026.10.3>

`scripts/prepare-cloudflared.mjs` verifies these SHA-256 digests before an
executable can be staged:

| BotFleet target | Release asset | Release asset SHA-256 | Extracted executable SHA-256 |
| --- | --- | --- | --- |
| macOS arm64 | `cloudflared-darwin-arm64.tgz` | `1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55` | `f249139e0541fa589c987397d867cc16c83ab1236d31eb6782f2e4552ee9cf80` |
| macOS x64 | `cloudflared-darwin-amd64.tgz` | `81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000` | `947e2942d6a59922d80190d23b12f3ade8da16e23e3bd937182a48993b7c00db` |
| Linux x64 | `cloudflared-linux-amd64` | `053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0` | same as release asset |
| Windows x64 | `cloudflared-windows-amd64.exe` | `76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2` | same as release asset |

For the two Darwin `.tgz` files, the checksum text in the release notes matches the extracted executable bytes, not the downloaded archive bytes.  The archive digests above match GitHub's current asset metadata and were recomputed from the downloaded release assets; the executable digests were recomputed from the extracted files and match the release checksum text.  Release review confirmed a Debian container base-image CA-store change; it does not establish a corresponding CA-bundle change in BotFleet's packaged macOS executable.

The staged executables are generated build output and are intentionally not
checked into git.  The preparation script downloads release archives from the
URL above (10 minute timeout, 3 attempts, 5 second delay between attempts)
and keeps a verified copy of each in a shared cache
(`~/Library/Caches/BotFleet/cloudflared-archives` on macOS) so a later
`build:cloudflared` run does not re-download an asset it already has. Set
`OMB_CLOUDFLARED_ARCHIVE_DIR` to point that cache at a directory containing
the exact official release assets instead, such as a reviewed local download.
A cached or provided archive is still checked against the SHA-256 digests
below before it is trusted; a mismatch is treated as a cache miss and
re-downloaded.

The macOS release process applies BotFleet's Developer ID signature to the
staged executable as part of signing the app bundle.  It verifies the unsigned
upstream digest before that necessary packaging change, then verifies the
nested signature, signing team, and architecture before notarization.  Linux
and Windows packages retain the exact reviewed upstream executable bytes.

The executable is also asked to report its own version, and that step waits
60 seconds with one retry.  `cloudflared version` prints in well under two
seconds on an idle host, so a longer wait costs nothing when the machine is
healthy, while a build running on a heavily loaded fleet host no longer
reports a saturated CPU as a version mismatch.  Only a timeout is retried: a
missing, non-executable, or wrong-version binary fails the same way twice, so
the error names what actually happened -- exit status, terminating signal, or
spawn error -- instead of a bare "did not identify as cloudflared".

cloudflared is licensed under Apache License 2.0.  The distribution includes a
separately named copy of the complete Apache 2.0 text at
`resources/licenses/cloudflared-LICENSE.txt`.
