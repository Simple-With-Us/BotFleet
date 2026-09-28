/**
 * The complete list of files this site publishes.
 *
 * `build.mjs` copies exactly these into `dist/`, and `verify-output.mjs`
 * fails if `dist/` contains anything that is not `index.html` plus this
 * list.  The site's source folder also holds README.md, docs/EFFORT-LOG.md,
 * vercel-ignore-hourly.sh, sync-status.mjs, build.mjs, template.html,
 * features.json, and package.json; none of them belong at a public URL, and
 * none of them may cross into `dist/` without being added here on purpose.
 *
 * Images only, plus the one association file the iOS app needs.  A new
 * script, stylesheet, or data file is a decision, not a side effect of
 * running the build.
 */
export const PUBLIC_ASSETS = [
  "apple-touch-icon.png",
  "favicon-64.png",
  "hero-bots.png",
  "icon-1024.png",
  "icon-transparent-1024.png",
  "logo-256.png",
  "swu-logo-wide.webp",
  "wide-banner-transparent.png",
  "wide-banner.png",
  ".well-known/apple-app-site-association",
];
