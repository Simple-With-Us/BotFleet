export function hasSlackReference(...values: Array<string | undefined | null>): boolean {
  return values.some((value) => /\bslack\b|slack-sync|slack-collab/i.test(value ?? ""));
}

/** An explicit, user-triggered conversion for old fleet coordination copy.
 * Generic Slack connected-app workflows remain untouched until the user
 * chooses this action for that saved routine or webhook. */
export function convertSlackReferenceToZulip(value: string): string {
  return value
    .replace(/slack-(?:sync|collab)/gi, "agent-sync")
    // Replace only the standalone product name.  A sentence-ending period is
    // not part of the word.  A period that starts a host (`slack.com`) is.
    // URLs, channel names, environment variables, and other identifiers stay
    // for manual review.
    .replace(/(?<![A-Za-z0-9_.-])slack(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/gi, "Zulip");
}
