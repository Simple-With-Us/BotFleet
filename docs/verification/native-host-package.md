# Native Host Package Smoke

The optional native headless host ships as its own artifact, beside the Mac
app and not inside it.  This recipe packages the checkout with the product's
own packager and then runs the packaged executable, so the identity the
artifact carries is proved on the real binary rather than on a fixture.

## What It Proves

`scripts/native-host-artifact.node-test.mjs` proves the identity logic with
synthetic binaries.  A fixture can be right about the logic and still say
nothing about the product:  the packager could fail to export the source, the
universal assembly could drop a slice, the archive could carry a stale
executable, or the stamp could be embedded in a way the binary itself cannot
read back.

This smoke runs the real path:

| Property | How | Failure cause |
|---|---|---|
| The real packager produces a real archive | `scripts/package-native-host.mjs --unsigned-dev` over the committed source, in a temporary directory outside the repository | the packager's own refusal, verbatim |
| The packaged executable reports the identity the receipt claims | the archive is opened again and `payload/bin/BotFleetNativeHost --identity` is run; the answer is compared with the receipt field for field | `identity <field> differs` |
| The receipt describes this commit | the receipt's source commit and build number are compared with the commit that was packaged | `the receipt says source`, `the receipt says build` |
| The bytes are the bytes the receipt names | the unpacked executable and the archive are hashed and compared with the receipt | `hashes to` |
| The artifact is the unsigned one and says so | the receipt must say `NOT DISTRIBUTABLE`, must not be distributable, must carry the `arm64` slice and must not claim a verified signature | `not distributable`, `no arm64 slice` |

## Running It

It needs macOS and the Swift toolchain, because the package is built there:
the packager exports the committed `ios` directory and builds the host for
`arm64` and `x86_64` from that export.

```sh
pnpm smoke:native-host-package
```

The build is a cold release build of both slices, so a first run takes a while.
`--keep` leaves the temporary directory in place so the archive can be looked
at; without it the directory is removed when the run ends.

The rules the smoke applies are proved on every host, macOS or not, by
`scripts/native-host-package-smoke.node-test.mjs`, which the native-release
chain runs.

## What It Never Does

It installs nothing, signs nothing, notarizes nothing, starts nothing, reads
no Keychain item, touches no service credential, publishes nothing and writes
no installed path.  The archive is unsigned on purpose:  its receipt says
`NOT DISTRIBUTABLE`, and that is what the smoke checks.
