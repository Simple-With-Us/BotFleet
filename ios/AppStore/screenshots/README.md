# App Store screenshots

`iPhone-6.9-roster.png` is captured from the Debug-only `-store-preview` fixture on an iPhone 17 Pro simulator. Re-capture it after any material roster or approval UI change, and capture the remaining product-page screens from a real paired device before submission.

`tv-face-preview.png` is captured from the Debug-only `-tvface-preview` harness (`bash scripts/ios-tvface-screenshot.sh` on macOS).  Commit updates when TV-Face avatar chrome changes; CI compares against this baseline when the file is present.
