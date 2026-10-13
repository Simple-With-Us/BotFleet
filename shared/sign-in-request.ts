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

/** Text from a JSON body or a tool argument.  Anything that is not a
 * string becomes empty, so a password object never becomes card text. */
export function inboundText(value: any): string {
  if (Object.prototype.toString.call(value) !== "[object String]") return "";
  return String(value).trim();
}

/** A public site hostname, or null when the text is not one.  Userinfo,
 * paths, and anything that could be a password are refused. */
export function signInSite(rawInput: string): string | null {
  const raw = rawInput.trim();
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

export function signInReason(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, 280);
}

const SECRET_BODY_KEYS = new Set(["password", "passwd", "otp", "totp", "secret", "passcode", "code"]);

/** True when a card action tried to send a secret.  Key match ignores
 * case, so PASSWORD and Otp are refused the same way as password.  The
 * caller refuses the request and must not log the value. */
export function signInBodyHasSecret(body: any): boolean {
  if (body == null || Array.isArray(body) || Object.prototype.toString.call(body) !== "[object Object]") return false;
  for (const key of Object.keys(body)) {
    if (!SECRET_BODY_KEYS.has(key.toLowerCase())) continue;
    const value = body[key];
    if (value != null && value !== "") return true;
  }
  return false;
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
