// Linq partner-API v3 types.  One shape per endpoint, named after the verb
// the spec uses so the wiring can be read top-to-bottom against the README at
// https://github.com/linq-team/ai-agent-example.  Every field is treated as
// `unknown` until the README confirms it; that kept this transport honest
// during the 2026-09-23 integration where the field-name question was the
// second-largest source of doubt after webhook signature.

export interface LinqApiError {
  status: number;
  code: string;
  message: string;
  /** Raw response body the server sent, when available — kept for logs. */
  body?: unknown;
}

export interface LinqSendResult {
  id: string;
}

export interface LinqUploadCredentials {
  uploadUrl: string;
  attachmentId: string;
  /** Headers Linq requires on the signed upload PUT (NOT the bearer token).
   *  A direct PUT to `uploadUrl` MUST replay these keys verbatim. */
  requiredHeaders: Record<string, string>;
}

export interface LinqChatInfo {
  id: string;
  participants: string[];
  isGroup: boolean;
  /** Display name Linq returns for the thread, only meaningful on groups. */
  displayName?: string;
  /** IM/RCS/SMS — used to reject SMS-only threads when an operator asked for
   *  iMessage only (the README's description of `service`). */
  service: "imessage" | "rcs" | "sms" | "unknown";
}

/** Inbound message from the Linq webhook, shaped for our bot runtime. */
export interface LinqInboundMessage {
  chatId: string;
  /** Sender phone number, E.164-formatted when Linq knows it. */
  fromNumber: string;
  /** Recipient phone number (one of cfg.botDefaults.imessage.linq.botNumber's
   *  numbers — which bot claimed the message). */
  toNumber?: string;
  /** Plain text body if Linq attached one.  Mutually common with media;
   *  both can arrive in one inbound. */
  text?: string;
  /** Media URLs Linq hosted, when present. */
  media?: Array<{ url: string; mimeType?: string; filename?: string }>;
  /** Group chats get a display name; 1:1 chats do not. */
  group: boolean;
  groupName?: string;
  messageId: string;
  /** ISO timestamp; downstream code compares with `Date.parse`. */
  sentAt: string;
}

/** Bot-scoped Linq configuration — used by the Linq voice tool, the
 *  per-bot PATCH path, and the workspace default; the runtime resolver
 *  consolidates these into a single ResolvedLinqBinding. */
export interface ImessageLinqConfig {
  botNumber: string;
  ignoredSenders?: string[];
  allowedSenders?: string[];
  /** Per-bot override of the workspace secret; absent falls back to env. */
  webhookSecret?: string;
}

/** Webhook payload subset the dispatcher cares about.  Linq's payload
 *  carries more fields we do not use; we accept-and-ignore those so a
 *  schema bump on Linq's side does not fail the receiver. */
export interface LinqMessageReceivedPayload {
  type: "message.received";
  chat_id: string;
  message_id: string;
  from: string;
  to?: string;
  body?: string;
  parts?: Array<{
    type: "text" | "image" | "video" | "audio" | "file";
    url?: string;
    mime_type?: string;
    filename?: string;
  }>;
  is_group?: boolean;
  group_name?: string;
  sent_at?: string;
}

export interface LinqMessageLifecyclePayload {
  type: "message.sent" | "message.delivered";
  message_id: string;
  chat_id?: string;
  at: string;
}

export type LinqWebhookEvent =
  | LinqMessageReceivedPayload
  | LinqMessageLifecyclePayload;
