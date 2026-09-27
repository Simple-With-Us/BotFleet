// The redactor moved to `shared/redact.ts`.
//
// It had to: `shared/tool-activity.ts` clips a failed tool result down to one
// transcript line, and that clip has to run AFTER redaction — a secret sliced
// first loses the closing marker (`END … PRIVATE KEY`, a JWT's signature, a
// quoted value's closing quote) that the patterns anchor on.  `shared/` must
// not import `server/`, so the pure function lives there and this file stays
// as the import path a dozen server modules already use.
export {
  LOG_TEE_MAX_STRING_CHARS,
  redactSecrets,
  redactSecretsForLog,
  redactSecretsInLogText,
  redactSecretsInText,
} from "../shared/redact.ts";
