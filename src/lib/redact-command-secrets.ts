/** Scrub credential-shaped `NAME=value` pairs from command lines shown in the UI. */
export function redactCommandSecrets(text: string): string {
  return text.replace(
    /\b([A-Z][A-Z0-9_]*(?:PW|PASSWORD|PASSWD|SECRET|TOKEN|KEY))=("[^"]*"|'[^']*'|[^\s]+)/g,
    "$1=<redacted>",
  );
}
