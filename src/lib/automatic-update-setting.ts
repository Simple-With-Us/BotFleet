import type { ConfigStatus } from "@/state/store";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function putAutomaticUpdateSetting(
  enabled: boolean,
  request: Fetcher = fetch,
): Promise<ConfigStatus> {
  const response = await request("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autoUpdate: { enabled } }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error ?? `Could not save automatic updates (${response.status}).`);
  }
  return body;
}
