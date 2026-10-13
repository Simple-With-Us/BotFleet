export function hasSlackReference(...values: Array<string | undefined | null>): boolean {
  return values.some((value) => /\bslack\b|slack-sync|slack-collab/i.test(value ?? ""));
}

/** An explicit, user-triggered conversion for old fleet coordination copy.
 * Generic Slack connected-app workflows remain untouched until the user
 * chooses this action for that saved routine or webhook. */
export function convertSlackReferenceToZulip(value: string): string {
  return value
    .replace(/slack-(?:sync|collab)/gi, "agent-sync")
    .replace(/slack\.com/gi, "simplewithus.zulipchat.com")
    .replace(/\bslack\b/gi, "Zulip");
}
