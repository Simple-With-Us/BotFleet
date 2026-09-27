// Linq partner-API v3 REST client.
//
// One exported function per endpoint, no module-level mutable state, every
// request accepts an `AbortSignal`.  Status and body are translated into a
// `LinqApiError` so callers never see a raw `Response` cross the boundary.
//
// The shape of every endpoint is based on the example repo at
// https://github.com/linq-team/ai-agent-example (README + `src/linq/client.ts`).
// We treat the field names there as authoritative until the official docs
// https://apidocs.linqapp.com say otherwise; the audit doc lists each field
// we call and where the name came from.

import type {
  LinqApiError,
  LinqChatInfo,
  LinqSendResult,
  LinqUploadCredentials,
} from "./types.ts";
import { loadConfig } from "../config.ts";

const DEFAULT_BASE_URL = "https://api.linqapp.com/api/partner/v3";

/** Pulled from env once at module init.  The auth token is re-read on
 *  every call so a test that sets `process.env.BOTFLEET_LINQAPP_API_KEY`
 *  (or the legacy `LINQ_API_TOKEN`) after import still lights up the
 *  client — set-once-and-forget would lock tests out of the partner
 *  API surface. */
function readConfig() {
  // Prefer the global-API-key name `BOTFLEET_LINQAPP_API_KEY`; fall back
  // to the lane-local `LINQ_API_TOKEN` so older deployments keep working.
  const token =
    process.env.BOTFLEET_LINQAPP_API_KEY?.trim() ||
    process.env.LINQ_API_TOKEN?.trim() ||
    "";
  const baseUrl = process.env.LINQ_API_BASE_URL?.trim() || DEFAULT_BASE_URL;
  // `BOTFLEET_LINQAPP_PHONE_NUMBER` is the workspace's primary bot phone
  // number on Linq; comma-separated `LINQ_AGENT_BOT_NUMBERS` continues to
  // work for installs that bind more than one number to the same token.
  const phoneEnv =
    process.env.BOTFLEET_LINQAPP_PHONE_NUMBER?.trim() ||
    process.env.LINQ_AGENT_BOT_NUMBERS?.trim() ||
    "";
  const botNumbers = phoneEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ignoredSenders = (process.env.IGNORED_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedSenders = (process.env.ALLOWED_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    token,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    botNumbers,
    ignoredSenders,
    allowedSenders,
  };
}

/** Snapshot at module init — kept for diagnostics that should not
 *  depend on the live env (which may swap on a desktop credential
 *  reload).  Re-fetched values live in `currentToken()` below. */
export const LINQ_CONFIG = readConfig();

function currentToken(): string {
  // Env first (operator injection / packaged-app boot), then the resolved
  // config: `imessageLinq.apiToken` carries the Infisical-resolved value
  // after secret hydration, and env alone would leave it ignored.
  return (
    process.env.BOTFLEET_LINQAPP_API_KEY?.trim() ||
    process.env.LINQ_API_TOKEN?.trim() ||
    loadConfig().imessageLinq?.apiToken?.trim() ||
    ""
  );
}

export function isLinqConfigured(): boolean {
  return Boolean(currentToken());
}

/** Build a typed error the rest of the bot can render.  We keep the raw body
 *  for the audit log but never echo `Response`-shaped objects. */
export async function makeError(res: Response, fallbackMessage: string): Promise<LinqApiError> {
  let body: unknown = undefined;
  let message = fallbackMessage;
  try {
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
        const parsed = body as { error?: { message?: string }; message?: string };
        if (parsed?.error?.message) message = parsed.error.message;
        else if (parsed?.message) message = parsed.message;
      } catch {
        body = text;
      }
    }
  } catch {
    /* ignore – we already have a fallback message */
  }
  return {
    status: res.status,
    code: res.status >= 500 ? "server_error" : res.status === 401 ? "unauthorized" : "http_error",
    message,
    body,
  };
}

async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const token = currentToken();
  if (!token) {
    throw new LinqApiErrorImpl({
      status: 0,
      code: "missing_token",
      message: "BOTFLEET_LINQAPP_API_KEY (or legacy LINQ_API_TOKEN) is not set; cannot call Linq API",
    });
  }
  // Re-read the base URL every call so a desktop credential reload can
  // pick up a repointed partner API host without a harness restart.
  // The documented base already ends in `/v3` (…/api/partner/v3) and every
  // path here is written as the docs list it (`/v3/chats/…`), so drop the
  // duplicate segment instead of calling …/v3/v3/….
  const { baseUrl } = readConfig();
  const url = baseUrl.endsWith("/v3") && path.startsWith("/v3/") ? `${baseUrl}${path.slice(3)}` : `${baseUrl}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    signal,
  };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(url, init);
}

export class LinqApiErrorImpl extends Error implements LinqApiError {
  status: number;
  code: string;
  body?: unknown;
  constructor(e: LinqApiError) {
    super(e.message);
    this.name = "LinqApiError";
    this.status = e.status;
    this.code = e.code;
    this.body = e.body;
  }
}

function ensureOk(res: Response, fallback: string): Promise<unknown> {
  if (res.ok) return res.status === 204 ? Promise.resolve(undefined) : res.json();
  return makeError(res, fallback).then((e) => {
    throw new LinqApiErrorImpl(e);
  });
}

interface SendMessageInput {
  text?: string;
  media?: Array<{ url?: string; attachmentId?: string }>;
  idempotencyKey?: string;
  replyTo?: string;
}

interface LinqSendResponse {
  message_id: string;
  id?: string;
}

export async function linqSendMessage(
  chatId: string,
  body: SendMessageInput,
  signal?: AbortSignal,
): Promise<LinqSendResult> {
  const parts: Array<Record<string, unknown>> = [];
  if (body.text) parts.push({ type: "text", value: body.text });
  if (body.media) {
    for (const m of body.media) {
      const part: Record<string, unknown> = { type: "media" };
      if (m.url) part.url = m.url;
      if (m.attachmentId) part.attachment_id = m.attachmentId;
      parts.push(part);
    }
  }
  const requestBody: Record<string, unknown> = {
    message: {
      parts,
    },
  };
  if (body.idempotencyKey) requestBody.idempotency_key = body.idempotencyKey;
  if (body.replyTo) requestBody.reply_to = body.replyTo;
  const res = await call("POST", `/v3/chats/${encodeURIComponent(chatId)}/messages`, requestBody, signal);
  const json = (await ensureOk(res, "linq: send failed")) as LinqSendResponse;
  return { id: json.message_id ?? json.id ?? "" };
}

export async function linqMarkRead(chatId: string, signal?: AbortSignal): Promise<void> {
  const res = await call("POST", `/v3/chats/${encodeURIComponent(chatId)}/read`, {}, signal);
  await ensureOk(res, "linq: markRead failed");
}

export async function linqStartTyping(chatId: string, signal?: AbortSignal): Promise<void> {
  const res = await call("POST", `/v3/chats/${encodeURIComponent(chatId)}/typing`, {}, signal);
  await ensureOk(res, "linq: typing start failed");
}

export async function linqStopTyping(chatId: string, signal?: AbortSignal): Promise<void> {
  const res = await call("DELETE", `/v3/chats/${encodeURIComponent(chatId)}/typing`, undefined, signal);
  await ensureOk(res, "linq: typing stop failed");
}

interface ReactionInput {
  operation: "add" | "remove";
  type: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question" | "custom";
  customEmoji?: string;
}

export async function linqAddReaction(
  messageId: string,
  reaction: ReactionInput,
  signal?: AbortSignal,
): Promise<void> {
  const body: Record<string, unknown> = {
    operation: reaction.operation,
    type: reaction.type,
  };
  if (reaction.customEmoji) body.custom_emoji = reaction.customEmoji;
  const res = await call("POST", `/v3/messages/${encodeURIComponent(messageId)}/reactions`, body, signal);
  await ensureOk(res, "linq: reaction failed");
}

export async function linqShareContactCard(
  chatId: string,
  contactCardPayload: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const res = await call(
    "POST",
    `/v3/chats/${encodeURIComponent(chatId)}/share_contact_card`,
    contactCardPayload,
    signal,
  );
  await ensureOk(res, "linq: contact-card share failed");
}

export interface LinqContactCard {
  name: string;
  photoUrl?: string;
}

export async function linqGetContactCard(
  phoneNumber: string,
  signal?: AbortSignal,
): Promise<LinqContactCard> {
  const qs = new URLSearchParams({ phone_number: phoneNumber });
  const res = await call("GET", `/v3/contact_card?${qs.toString()}`, undefined, signal);
  const json = (await ensureOk(res, "linq: contact-card fetch failed")) as {
    name?: string;
    photo_url?: string;
  };
  return { name: json.name ?? "", photoUrl: json.photo_url };
}

export async function linqGetUploadUrl(
  mimeType: string,
  filename: string,
  sizeBytes: number,
  signal?: AbortSignal,
): Promise<LinqUploadCredentials> {
  // `size_bytes` is required: the presigned PUT must carry exactly this many
  // bytes (https://docs.linqapp.com/api/resources/attachments/methods/create/).
  const res = await call(
    "POST",
    "/v3/attachments",
    { filename, content_type: mimeType, size_bytes: sizeBytes },
    signal,
  );
  const json = (await ensureOk(res, "linq: get-upload-url failed")) as {
    attachment_id: string;
    upload_url: string;
    required_headers?: Record<string, string>;
  };
  return {
    attachmentId: json.attachment_id,
    uploadUrl: json.upload_url,
    requiredHeaders: json.required_headers ?? {},
  };
}

interface ChatInfoRaw {
  id: string;
  display_name?: string;
  handles?: string[];
  is_group?: boolean;
  service?: "iMessage" | "RCS" | "SMS" | "imessage" | "rcs" | "sms";
}


/** Create (or return) a 1:1 chat with the given E.164 phone number. */
export async function linqCreateChat(
  phoneNumber: string,
  signal?: AbortSignal,
): Promise<LinqChatInfo> {
  const res = await call(
    "POST",
    "/v3/chats",
    { participants: [{ phone_number: phoneNumber }] },
    signal,
  );
  const json = (await ensureOk(res, "linq: createChat failed")) as {
    id?: string;
    chat_id?: string;
    display_name?: string;
    is_group?: boolean;
    service?: string;
    handles?: string[];
  };
  return {
    id: json.id ?? json.chat_id ?? "",
    displayName: json.display_name,
    isGroup: Boolean(json.is_group),
    service: (json.service as LinqChatInfo["service"]) ?? "unknown",
    participants: json.handles ?? [phoneNumber],
  };
}

export async function linqGetChat(chatId: string, signal?: AbortSignal): Promise<LinqChatInfo> {
  const res = await call("GET", `/v3/chats/${encodeURIComponent(chatId)}`, undefined, signal);
  const json = (await ensureOk(res, "linq: getChat failed")) as ChatInfoRaw;
  const serviceLower = (json.service ?? "").toLowerCase();
  const service: LinqChatInfo["service"] =
    serviceLower === "imessage"
      ? "imessage"
      : serviceLower === "rcs"
        ? "rcs"
        : serviceLower === "sms"
          ? "sms"
          : "unknown";
  return {
    id: json.id,
    participants: json.handles ?? [],
    isGroup: Boolean(json.is_group),
    displayName: json.display_name,
    service,
  };
}

interface ChatPatchInput {
  displayName?: string;
  groupChatIcon?: string;
}

export async function linqUpdateChat(
  chatId: string,
  patch: ChatPatchInput,
  signal?: AbortSignal,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.displayName !== undefined) body.display_name = patch.displayName;
  if (patch.groupChatIcon !== undefined) body.group_chat_icon = patch.groupChatIcon;
  const res = await call("PUT", `/v3/chats/${encodeURIComponent(chatId)}`, body, signal);
  await ensureOk(res, "linq: updateChat failed");
}

/** Direct PUT to a signed S3-style URL Linq returned.  We replay only the
 *  headers Linq told us to set — the bearer token must NOT cross this
 *  boundary, it lives on the partner-API calls only. */
export async function linqUploadBytes(
  uploadUrl: string,
  bytes: Uint8Array,
  mimeType: string,
  requiredHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  // If Linq's required_headers already carries Content-Type (any casing),
  // do not also set content-type — fetch joins duplicates and breaks the
  // presigned signature.
  const headers: Record<string, string> = { ...requiredHeaders };
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
  if (!hasContentType) headers["content-type"] = mimeType;
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers,
    body: bytes,
    signal,
  });
  if (!res.ok) {
    throw new LinqApiErrorImpl(await makeError(res, "linq: signed upload failed"));
  }
}
