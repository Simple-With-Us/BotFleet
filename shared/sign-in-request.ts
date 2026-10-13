// A sign-in card names a site.  It never carries a password, a one-time
// code, or any other secret.  The person types those on the computer where
// the bot works, and that text never enters app state, logs, or chat.

export interface SignInRequestCardData {
  site: string;
  reason: string;
  status: "open" | "done" | "cancelled" | "replaced";
  resumed?: boolean;
  error?: string;
}

const HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** A public site hostname, or null when the text is not one.  Userinfo,
 * paths, and anything that could be a password are refused. */
export function signInSite(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw || raw.length > 2048) return null;
  if (/\s/.test(raw)) return null;
  let host = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes("/")) {
    try {
      const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
      if (url.username || url.password || url.search || url.hash) return null;
      if (url.pathname !== "/" && url.pathname !== "") return null;
      host = url.hostname;
    } catch {
      return null;
    }
  }
  if (host.includes("@") || host.includes(":")) return null;
  host = host.replace(/\.$/, "").toLowerCase();
  if (!HOST.test(host)) return null;
  return host;
}

export function signInReason(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/\s+/g, " ").trim().slice(0, 280);
}

const SECRET_BODY_KEYS = ["password", "passwd", "otp", "totp", "secret", "passcode", "code"] as const;

/** True when a card action tried to send a secret.  The caller refuses
 * the request and must not log the value. */
export function signInBodyHasSecret(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return SECRET_BODY_KEYS.some((key) => {
    const value = record[key];
    return value !== undefined && value !== null && value !== "";
  });
}

export function signInResumePrompt(site: string, outcome: "done" | "cancelled"): string {
  if (outcome === "done") {
    return (
      `The person signed in to ${site} on this bot's computer.  Check that the site shows them signed in, then continue the task.  ` +
      "You never receive their password.  Do not ask them to paste a password or one-time code into chat."
    );
  }
  return (
    `The person declined to sign in to ${site}.  Continue without that sign-in if you can, or explain what you cannot do.  ` +
    "Do not ask them to paste a password or one-time code into chat."
  );
}
