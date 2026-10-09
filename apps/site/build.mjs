#!/usr/bin/env node
// Renders index.html from template.html + features.json into dist/.
// Rules encoded here: a section with zero features is hidden entirely
// (owner rule: hide a section if it has zero features); descriptions are
// trusted HTML (sentence gaps use a real U+00A0 per fleet copy rules —
// never the &nbsp; entity, so the six characters can't leak as text).
//
// The output directory is `dist/`, and Vercel serves `dist/`, NOT this
// directory.  It used to serve `.` — the same directory that holds README.md,
// docs/EFFORT-LOG.md, vercel-ignore-hourly.sh, sync-status.mjs, this build
// script, and package.json — so every one of those was readable at
// https://botfleet.app/<name>.  Only the allowlist below crosses into dist/;
// anything added to this folder is NOT published until it is listed there.
// `verify-output.mjs` fails the build's own test if dist/ grows a file the
// allowlist does not explain.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_ASSETS } from "./public-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "dist");

const data = JSON.parse(readFileSync(new URL("./features.json", import.meta.url), "utf8"));
const template = readFileSync(new URL("./template.html", import.meta.url), "utf8");
const REPO = data.site.repo;

function provHtml(prov) {
  if (prov.type === "host") return prov.note;
  if (prov.type === "main") {
    const note = prov.note ? ` · ${prov.note}` : "";
    return `Merged to <a href="${REPO}">main</a>${note}`;
  }
  if (prov.type === "pr") {
    const links = prov.prs.map((n) => `<a href="${REPO}/pull/${n}">#${n}</a>`).join(", ");
    const plural = prov.prs.length > 1 ? "Pull requests" : "Pull request";
    const state = prov.note ?? prov.state;
    return `${plural} ${links} · ${state}`;
  }
  throw new Error(`unknown prov type: ${prov.type}`);
}

function cardHtml(f) {
  return `      <article class="card">
        <h3>${f.title}</h3>
        <p>${f.desc}</p>
        <div class="prov">${provHtml(f.prov)}</div>
      </article>`;
}

function sectionHtml(s) {
  if (!s.features.length) return "";
  return `  <section class="features" id="${s.id}">
    <h2>${s.title} <span class="badge ${s.badge}">${s.badgeLabel}</span></h2>
    <p class="sub">${s.sub}</p>
    <div class="grid">

${s.features.map(cardHtml).join("\n\n")}

    </div>
  </section>`;
}

const updated = new Date().toLocaleDateString("en-US", {
  weekday: "short", month: "short", day: "numeric", year: "numeric",
  timeZone: "America/Chicago",
});

function sentrySnippet(dsn) {
  const trimmed = (dsn || "").trim();
  if (!trimmed.startsWith("https://")) return "";
  // Public client DSN only.  Do not log the value.
  const json = JSON.stringify(trimmed);
  return `<script src="https://browser.sentry-cdn.com/10.73.0/bundle.tracing.replay.feedback.min.js" crossorigin="anonymous"></script>
<script>
(function () {
  if (typeof Sentry === "undefined") return;
  Sentry.init({
    dsn: ${json},
    environment: "production",
    tracesSampleRate: 0.2,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    enableLogs: true,
    integrations: [
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
      Sentry.feedbackIntegration({ colorScheme: "light", autoInject: true, showBranding: false, buttonLabel: "Report a problem", submitButtonLabel: "Send", formTitle: "Report a problem" })
    ]
  });
})();
</script>`;
}

const html = template
  .replaceAll("{{TESTFLIGHT_URL}}", data.site.testflightUrl)
  .replaceAll("{{REPO_URL}}", data.site.repo)
  .replaceAll("{{UPSTREAM_URL}}", data.site.upstream)
  .replaceAll("{{RELEASES_URL}}", data.site.releases)
  .replaceAll("{{MAC_DOWNLOAD_URL}}", data.site.macDownload)
  .replaceAll("{{MAC_DOWNLOAD_INTEL_URL}}", data.site.macDownloadIntel)
  .replaceAll("{{ROSTER}}", data.exampleFleet.map((b) => `<span>${b}</span>`).join(""))
  .replaceAll("{{UPDATED}}", updated)
  .replaceAll("{{SECTIONS}}", data.sections.map(sectionHtml).join("\n\n"))
  .replaceAll("{{SENTRY_SNIPPET}}", sentrySnippet(process.env.VITE_SENTRY_DSN));

// A clean dist/ every run: a file dropped here once and then deleted from
// PUBLIC_ASSETS would otherwise stay published, because Vercel deploys
// whatever is on disk rather than what this script wrote most recently.
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "index.html"), html);
for (const asset of PUBLIC_ASSETS) {
  const target = join(OUT_DIR, asset);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(here, asset), target);
}
console.log(
  `built dist/index.html — ${data.sections.map((s) => `${s.id}:${s.features.length}`).join(" ")} — ` +
  `${PUBLIC_ASSETS.length + 1} published files — updated ${updated}`,
);
