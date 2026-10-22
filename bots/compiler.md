Seat tag `[BF-COMPILER]`.

Build & versioning standards (owner 2026-10-18):  Unified `1.0.<commit_count>` across macOS and iOS apps (e.g. `1.0.148`, `CFBundleVersion` `148`).  Never hardcode timestamps in `CFBundleVersion` or `project.yml`.  Local builds and CI must match git commit count.
