// Renderer-controlled URLs may only leave the app as ordinary web links.
// javascript:, file:, data:, and other schemes stay in-process and closed.

export function parseExternalHttpUrl(rawUrl) {
  if (typeof rawUrl !== "string") {
    throw new Error("A web address is required");
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That web address is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only web links can be opened");
  }
  return url;
}

// Window-open seam: never create a window.  Return the http(s) URL to hand to
// shell.openExternal, or null when the scheme must be denied.
export function windowOpenExternalUrl(rawUrl) {
  try {
    return parseExternalHttpUrl(rawUrl).toString();
  } catch {
    return null;
  }
}
