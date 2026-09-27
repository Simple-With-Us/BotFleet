// Keeping secrets out of the native protocol log — and out of the transcript.
//
// The native tee writes every provider message verbatim, which is what makes
// protocol drift diagnosable — but the messages that set a session up carry
// the credentials the agent is handed: the box token and the comms token
// travel inside `session/new`'s mcpServers env, and a Composio consumer key
// travels in an MCP header.  Those logs sit in ~/.botfleet/native as
// ordinary files, are read by anyone debugging, and get pasted into issues.
//
// So the log keeps the SHAPE and loses the VALUES: a redacted entry still
// tells you a token was passed, under which name, and how long it was —
// enough to debug "the proxy got no token" without the token being there.
//
// This lives in `shared/` rather than `server/` because the other caller is
// `shared/tool-activity.ts`, which clips a tool result down to one line for
// the transcript — and that clip has to happen AFTER redaction, not before
// (see the truncation note below).  `server/redact.ts` re-exports both
// entry points, so every existing server importer is unaffected.
//
// Truncation is the reason these patterns are shaped the way they are.  A
// secret that has been cut in half upstream has lost the closing marker a
// naive pattern anchors on — the `END … PRIVATE KEY` trailer, a JWT's third
// segment, a quoted value's closing quote.  Redacting before the clip is the
// real fix; recognising the truncated shapes is the belt to that braces,
// because the detail also arrives pre-clipped on paths we do not own.

/** Key names whose value is a credential.  Matched case-insensitively as a
 * substring, so KEY catches ANTHROPIC_API_KEY and x-api-key. */
const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];

/** `key` alone is too broad — it matches `keyboard`, `keys`, `hotkey`.  Only
 * treat it as a credential when it stands alone or is a suffix, which is how
 * every real one is spelled (API_KEY, consumer-key, xai_key). */
function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

const mask = (value: string) => `«redacted ${value.length} chars»`;

// ── content-shaped secrets ────────────────────────────────────────────
// What a bot's own reply, a tool title, or a permission card can carry —
// and, since the rebuild replays activity into every handed-over context,
// what would otherwise become permanent.  High precision on purpose: a
// generic "long hex/base64" heuristic would rewrite real code in the
// transcript, so only shapes that are unmistakably credentials match.

const KEY_PREFIXES: RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // anthropic / openai / stripe
  // xAI ships as a BotFleet engine, so a Grok key pasted into a tool result
  // or a permission card is a credential this product hands its own users.
  // Groq and Hugging Face ride along: same shape of prefix, same cost if one
  // goes out in a bug report.
  /\bxai-[A-Za-z0-9_-]{20,}/g, // xai (grok)
  /\bgsk_[A-Za-z0-9]{40,}/g, // groq
  /\bhf_[A-Za-z0-9]{30,}/g, // hugging face
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // github fine-grained
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // google api key
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm
  // jwt — the third segment is OPTIONAL and unbounded on purpose: a token
  // clipped at 240 characters loses its signature (and often the tail of
  // its payload), and the header alone is `{"alg":…}`, so anchoring on a
  // complete three-segment token is exactly what lets a cut one through.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g,
];
/** `Bearer <token>` standing on its own, anywhere.  Case-insensitive: a
 * lowercase spelling is just as much a credential, and the 12-character
 * minimum is what keeps "Bearer tokens are sent in the …" out of it. */
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
// ── authorization headers ────────────────────────────────────────────
// The whole value of an authorization header, whatever scheme it names.
//
// `KEY_VALUE` cannot reach this one: a scheme-prefixed credential has a
// SPACE in it, and KEY_VALUE's value is deliberately space-free so that
// prose after a colon does not match.  Anchoring on the header NAME instead
// is what makes that space safe — and it is why the scheme words are not
// spelled out here.  A bare scheme word would be a false-positive machine
// ("Basic authentication requires…", "Token expired yesterday"); the same
// word behind this header name cannot be prose.  The scheme is kept, so the
// line still says what kind of credential went out.
//
// The value runs to the END of the header value, not to the end of the first
// token, because a structured credential carries its secret in a LATER part:
// SigV4 signs with `…, Signature=<secret>` after two harmless parameters, and
// Digest's own parameters are comma-separated and individually quoted.  The
// value therefore crosses commas and semicolons.
//
// Where it STOPS is decided by CONTEXT — by how the value was introduced —
// and not by scanning forward for pairs of quotes.  That is why there are two
// patterns below rather than one.  A single pattern that stepped over
// balanced quote pairs had to answer both questions at once, and got each of
// them wrong in the other's direction: it needed a length cap on the quoted
// part so that a serialized object's siblings were not eaten, and that same
// cap is what let an OAuth `oauth_signature` longer than the cap end the
// match early and ship the signature into the transcript and into Sentry.
// Asking how the value was introduced answers both at once.

/** An authorization value INTRODUCED BY A QUOTE — the JSON and config
 * spelling, `"authorization": "Bearer …"` or `authorization='…'`.
 *
 * The quote that opened it is what ends it, so the value runs to the matching
 * close, crosses no quote at all, and takes no length cap.  Nothing past that
 * quote is touched, which is the whole point: a one-line serialized object
 * carries `,"status":"ok","message":"…"` after the header key, and those
 * siblings used to be eaten by the balanced-quote scan and were then
 * permanently missing from stored bot text and from failure details.
 *
 * A backslash escape is stepped over rather than mistaken for the close, so
 * a quote inside the string does not end the value early.  The two branches
 * are disjoint on their first character (one requires a backslash, the other
 * forbids it), which is what keeps this linear on a string that never
 * closes.
 *
 * END OF TEXT closes it too, because a value whose closing quote was clipped
 * away upstream has no other end left.  That fallback fires only where the
 * run really did reach the end — a quote of its own kind would have stopped
 * it first — so it can never be the path a terminated value takes, and the
 * siblings are still safe.  It is the one shape `KEY_VALUE_UNTERMINATED`
 * cannot reach: OAuth and Digest write ESCAPED quotes inside the value, and
 * that pattern's value class stops at the first quote of any kind. */
const AUTH_HEADER_QUOTED =
  /\b((?:proxy-)?authorization)(["']?\s*[=:]\s*)(["'])([A-Za-z][A-Za-z0-9-]{2,}\s+)?((?:\\.|(?!\3)[^\\\r\n])+)(\3|$)/gi;

/** A BARE authorization value — an HTTP header line as `curl -v`, an access
 * log, or an echoed stderr line prints it.
 *
 * Nothing closes this one but the line, so it runs to the end of the line and
 * crosses quoted parameters of ANY length.  That length is the whole defect
 * this replaces: OAuth hides its secret in `oauth_signature="…344 chars…"`
 * and SigV4 in a trailing `Signature=…`, and any cap on the quoted part ends
 * the match before either of them and leaves the signature in the clear.
 *
 * "The line" means the line the credential is on, which is not always the
 * line the header name is on: a FOLDED header (RFC 7230 obs-fold, and what
 * a pretty-printer produces) puts the break between the scheme and the
 * credential, `Digest\n  username="…", response="<secret>"`.  That is why
 * the separator after the scheme is `\s+` and not horizontal whitespace —
 * restricting it leaves the bare pattern looking at a six-character
 * `Digest` and declining, and no later pattern knows what the continuation
 * line is.
 *
 * Which quotes on that line belong to the value is decided the same way —
 * by context, and the context is not on the header line at all.  A quote in
 * a header value is just a character; the only quote that must survive is
 * the one WRAPPING the header, `curl -H "…"`, and that quote announced
 * itself before the header name.  So the value runs to the end of its line
 * and is then cut at the wrapper's closing quote if a wrapper was open —
 * see `wrapperQuoteAt`, which asks how that quote OPENED to know a delimiter
 * from prose, which nesting level it belongs to, and whether the text around
 * it is escaped — and at nothing else.
 *
 * That is the third answer this pattern has had, and the first that is a
 * rule rather than a guess.  Reading the value's own quotes to find its end
 * cannot work, because nothing on the line distinguishes a parameter's quote
 * from a wrapper's: `oauth_signature="…"` and a `Basic` credential whose
 * base64 padding leaves an `=` in front of the wrapper look identical, `\"`
 * is the parameter's delimiter inside a shell argument and an escape inside
 * it on a raw line, and a clipped parameter and a terminal wrapper both end
 * the text.  Every one of those was a real leak or a real over-mask found
 * against a version of this pattern that tried to tell them apart locally.
 * Asking who opened the quote answers all of them at once, and asking it
 * OUTSIDE the value is what makes the answer available. */
const AUTH_HEADER_BARE = /\b((?:proxy-)?authorization)(["']?\s*[=:](?!\s*["'])\s*)([A-Za-z][A-Za-z0-9-]{2,}\s+)?([^\r\n]+)/gi;

/** The quote wrapping the header, if the header sits inside one — the `"` of
 * a `curl -H "…"` argument, the `'` of its single-quoted twin, or either of
 * those already backslash-escaped because the command reached us inside a
 * string of somebody else's.
 *
 * Looks only BEFORE the header name, on its own line, because that is where a
 * wrapper announces itself and it is the one thing the value cannot tell you
 * about itself.  Three things make the answer trustworthy:
 *
 * ADJACENCY is the whole test, and it is the whole implementation too: the
 * argument that wraps a header opens immediately in front of it, whitespace
 * apart, so the wrapper is simply the quote you find by stepping backwards
 * over blanks.  `-H "…`, `-H'…`, `-H"…` (shell quoting may start mid-word),
 * `\"…` one escaping level up, and a log line's `sent header "<header>: …"`
 * all qualify.
 *
 * A quote with text between it and the header name wraps something else, or
 * nothing at all — `size=2"; <header>: …`, `he said "wat; <header>: …` — and
 * cutting the value there leaves a stub and hands the credential back in the
 * clear.  An apostrophe in `it's` is harmless for the same reason.  An
 * adjacent quote that CLOSES rather than opens does the same damage
 * (`curl "prefix"<header>: …`), and counting the ones before it at the same
 * escape level says which it is.
 *
 * Adjacency is what lets this NOT parse shell quoting, which is the part
 * that cannot be got right from one line of text: tracking open quotes with
 * a stack has to decide whether the `'` in `echo "it's ready"` is a nested
 * opener or a literal, and whether the `"` inside `bash -c '…'` is a literal
 * or the inner shell's delimiter.  Both readings are correct at some level
 * and each one breaks the other's case.  The quote in front of the header is
 * the header's delimiter whichever level it belongs to, so the question
 * never has to be answered.
 *
 * And a wrapper carries its ESCAPING LEVEL, because the text may already be
 * quoted once over — a driver that hands us `curl -H \"<header>: …\" <url>`
 * has wrapper quotes spelled `\"`, and one closes the argument exactly where
 * a bare `"` would in unescaped text.  A wrapper opened as `\"` is closed by
 * `\"`; a bare one by a bare one. */
interface Wrapper {
  quote: string;
  /** how many backslashes the wrapper was written behind — 0 for `"`, 1 for
   * `\"` one escaping level up, and so on.  Its partner is written the same
   * way, and a quote behind a DIFFERENT run belongs to a different level. */
  backslashes: number;
}

function wrapperQuoteAt(text: string, index: number): Wrapper | undefined {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  let at = index - 1;
  while (at >= lineStart && /\s/.test(text.charAt(at))) at -= 1; // whitespace apart
  if (at < lineStart) return undefined;
  const quote = text.charAt(at);
  if (quote !== '"' && quote !== "'") return undefined;
  let backslashes = 0;
  while (at - 1 - backslashes >= lineStart && text.charAt(at - 1 - backslashes) === "\\") backslashes += 1;
  // The adjacent quote has to be OPENING one.  A shell word can concatenate a
  // quoted prefix straight onto the header — `curl "prefix"<header>: …` — and
  // that quote closes the prefix; cutting the value at the next quote would
  // leave a stub and hand the credential back.  Counting the ones before it
  // at the same escape level settles it without parsing anything: an even
  // count makes this one the odd, opening member of its pair.
  //
  // A quote PROTECTED by the opposite quote type is not one of the ones being
  // counted, though: `echo '"' && curl -H "<header>: …` has a literal `"`
  // sitting inside `'…'`, and bash never reads a character inside single
  // quotes as a delimiter at all.  Tallying it as a real toggle throws the
  // parity off and makes the genuine `-H "` opener that follows look like a
  // closer instead — the wrapper is lost and redaction runs off the end of
  // the value.  So this replays the line's quoting one region at a time
  // rather than counting raw characters: a quote of the OTHER type only ever
  // opens or closes ITS OWN region and is never tallied; a quote of the
  // target type only toggles the tally while no other region is already
  // open, which is exactly what "literal inside the opposite quote" means.
  let seen = 0;
  let openQuote: string | undefined;
  for (let i = lineStart; i < at; i++) {
    const ch = text.charAt(i);
    if (ch !== '"' && ch !== "'") continue;
    let run = 0;
    while (i - 1 - run >= lineStart && text.charAt(i - 1 - run) === "\\") run += 1;
    if (run !== backslashes) continue; // a different escaping level; not this pairing at all
    if (openQuote === undefined) {
      openQuote = ch; // opens a region of ch's type
      if (ch === quote) seen += 1;
    } else if (ch === openQuote) {
      openQuote = undefined; // closes the region it opened
      if (ch === quote) seen += 1;
    } // else: ch is the opposite type while a region is open — a literal, not a toggle
  }
  return seen % 2 === 0 ? { quote, backslashes } : undefined;
}

/** How much of a bare header value is the credential: everything up to the
 * wrapper's closing quote, or all of it when nothing wrapped the header.
 *
 * The closing quote is the one written at the wrapper's OWN escaping level,
 * which is why the backslash run has to match exactly rather than merely be
 * odd or even.  A command serialized one level up wraps with `\"` and writes
 * its own quoted parameters `\\\"` — three backslashes, the next level in —
 * and stopping at one of those masks through `oauth_signature=\\` and leaves
 * the signature standing.
 *
 * And the FIRST such quote either closes the argument or the wrapper was
 * never real.  A closing quote is followed by whitespace, by the end of the
 * line, or by a shell separator — a redirection counts, because bash reads
 * `-H "…">trace.log` as an operator and the quote really did close there,
 * and so does a `$` expansion or another quote, because bash glues an
 * adjacent quoted and unquoted run into one word.  A quote followed by an
 * ordinary LETTER is the one shape that stays disqualifying, even though
 * bash would glue that too: `realm="public"` looks exactly like it, and
 * accepting it puts the parameters after the cut back in the clear.  The
 * cost is over-masking a `-H "…"suffix` tail, which loses context and no
 * secret; a quote followed by ordinary text opened
 * something instead, which means the quote in front of the header was not an
 * argument's opener after all and every rule above it was reasoning about
 * the wrong thing.  There is no salvaging a later candidate in that case —
 * cutting at one would leave the parameters before it in the clear — so the
 * whole line's value is masked, which loses a reader some context and loses
 * no secret.
 *
 * A `$` or backtick right behind the quote is not automatically that closing
 * quote either — it is the START of a glued, unquoted run, and bash keeps
 * gluing: an OAuth/Digest-style value can toggle the SAME quote back on for
 * its next field instead of escaping — `realm="$REALM", oauth_signature="…"`
 * is one continuous `-H` argument (confirmed against bash 5.2.21) — and the
 * quote right before `$REALM` is indistinguishable, on its own, from the
 * wrapper's real close.  So a `$`/backtick run is walked forward rather than
 * trusted: if it runs into whitespace or a separator with no further quote of
 * this wrapper's kind, the word really did end at the quote that introduced
 * the run, exactly as `-H "…token…"$SUFFIX <url>` needs.  If it runs into
 * ANOTHER quote of this wrapper's kind first, the value was never closed at
 * all — quoting merely toggled off and back on — so that quote is not a
 * candidate close either; scanning resumes past it, looking for whichever
 * quote closes THAT segment, so a later field like `oauth_signature` is not
 * left standing past a requote that looked like the end.
 *
 * That forward scan for a requote does not run unbounded, though: bash only
 * keeps a `$`/backtick run GLUED to what follows while nothing separates
 * them, and a shell-word boundary — whitespace, `&&`, `;`, `|` — ends the
 * word right there whether or not a same-type quote shows up later on the
 * line.  Scanning past that boundary anyway is what let an unrelated later
 * command, `"…token…"$SUFFIX https://example.com && echo "done"`, be read as
 * one continuous value all the way to `"done"`'s closing quote — the search
 * has to stop at the boundary and treat the run as ended right there, the
 * same as if no further quote existed at all.
 *
 * A boundary inside a NESTED EXPANSION is not a boundary, though — command
 * substitution replaces the whole `$(…)` with its output before the shell
 * word is assembled, so whitespace between its parens never splits the word:
 * `realm="$(printf zone)", oauth_signature=<secret>"` is one `-H` argument
 * (confirmed against bash 5.2.21), and stopping at the space inside `$(…)`
 * left `oauth_signature` standing past a boundary that was never real.  So
 * `$(` is walked to its balanced `)` — tracking depth, because the command
 * itself may contain nested parens — as one atomic span with no boundary
 * check inside it, and a backtick run is walked the same way to its matching
 * backtick.  Both walks consume the run in one linear pass with no
 * backtracking, so this stays O(n) on a pathological line.
 *
 * A paren INSIDE A QUOTE, inside that same `$(…)`, does not change the
 * depth either — bash parses a quoted or escaped `)` as part of the
 * substituted command, not as the substitution's own close
 * (`$(printf ') value')` is one substitution whose argument happens to
 * contain a literal `)`).  Counting it anyway closed the span early and
 * left the space right after it looking like a real boundary again, the
 * same failure this depth tracking exists to prevent — just one quoting
 * level deeper.  So the depth walk keeps its own miniature quote state:
 * a `'`/`"` toggles it, a backslash steps over the character after it
 * (outside single quotes, where bash never treats backslash as an escape
 * at all), and `(`/`)` only move `depth` while no quote is open.
 *
 * A backslash-escaped character glues to the run the same way, and outside
 * any expansion at all: `realm="$REALM\ value", oauth_signature=<secret>"`
 * is one `-H` argument (confirmed against bash 5.2.21) because the escaped
 * space is preserved literally rather than ending the shell word.  So the
 * lookahead steps over any `\`-prefixed character as a single atomic unit
 * before testing for a boundary — the same "consume it whole, do not let a
 * character inside it decide anything on its own" treatment `$(…)` and a
 * backtick span already get.
 *
 * `$'…'`, `${…}`, and `<(…)`/`>(…)` glue on the same way, each for its own
 * reason.  `$'foo bar'` (ANSI-C quoting) is QUOTED syntax — bash processes
 * its own backslash escapes inside it, so `\'` is a literal quote rather
 * than the close — and is walked to its own matching quote, not treated as
 * a balanced span.  `${REALM:-'foo bar'}` (parameter expansion) shares the
 * quote-aware balancing `$(…)` uses, just brace-delimited instead of
 * paren-delimited — its fallback/pattern operators can carry quoted
 * whitespace of their own.  `<(list)`/`>(list)` (process substitution) is
 * replaced by a filename before the word is assembled, same as `$(…)` is
 * replaced by output, and is walked with the identical `walkBalancedSpan`
 * this shares with `$(…)` and `${…}`.  A BARE `<`/`>` not followed by `(`
 * is still a real redirection and keeps closing the argument the way it
 * always has — only the paren-bearing form is treated as an expansion at
 * all, so this cannot swallow a genuine `-H "…"><url` the way accepting
 * every `<`/`>` would.
 *
 * An empty INLINE parameter needs the identical requote treatment for a
 * reason that has nothing to do with `$` or backticks: `realm=""` opens and
 * closes the SAME quote with nothing between, which is exactly how bash
 * glues a quoted segment back onto a following one — `realm="$REALM"` does
 * it with a variable in the gap, `realm=""` does it with an empty gap.  Read
 * as an ordinary "does this close" test, though, the adjacent closing quote
 * of the empty pair looks identical to a wrapper's TRUE close glued to a new
 * quoted shell word (`"…token…""more"`, tested below) — the only thing that
 * tells them apart is what precedes the opening quote.  A parameter only
 * opens behind `=` (RFC 7235 auth-param); a wrapper's own close is not, so
 * gating on that keeps `"…token…""more"` stopping where it always did while
 * `realm=""` is treated as a requote and the scan keeps going — which is
 * what stops an unrelated same-type literal earlier on the line (a poisoned
 * opener count) from landing the cut on `realm=` and shipping whatever
 * credential field comes after it. */

/** Walks a backtick command substitution to its matching close, starting AT
 * the opening backtick, and returns the index right after that close (or
 * `value.length` if it never closes).
 *
 * The first backquote NOT preceded by a backslash terminates the form (Bash
 * manual, Command Substitution) — so a literal, escaped backtick inside one
 * (`` `printf '\`value'` `` is one substitution whose argument happens to
 * contain a literal backtick) must not be read as the close.  Only `` \` ``
 * specifically is special here: this function exists to find a BOUNDARY,
 * not to interpret every backslash escape backticks recognise, and bash
 * itself leaves a backslash before anything else in a backquoted string
 * untouched, so treating unrelated `\x` pairs as atomic would walk past a
 * close that bash does not. */
function walkBacktick(value: string, backtickIndex: number): number {
  let k = backtickIndex + 1;
  while (k < value.length) {
    if (value.charAt(k) === "\\" && value.charAt(k + 1) === "`") {
      k += 2;
      continue;
    }
    if (value.charAt(k) === "`") return k + 1;
    k += 1;
  }
  return value.length;
}

/** How many levels of NESTED expansion `walkBalancedSpan` will recurse
 * into before it stops trying to balance precisely and falls back to flat
 * `open`/`close` counting instead.  Generous against anything a real shell
 * command would ever nest — and load-bearing: untrusted bot/tool output can
 * hand this function roughly 5,000 nested `$(` openers in one line, and
 * recursing into every one of them overflows the call stack and throws,
 * which aborts `redactSecretsInText` (and, through `Bus.publish`, ordinary
 * event processing) rather than merely losing diagnostic precision.  Flat
 * counting beyond this depth is not perfectly shell-accurate for MIXED
 * bracket nesting that deep, but it cannot crash, and content that pathological
 * has no realistic legitimate source. */
const MAX_EXPANSION_NESTING = 64;

/** Walks a balanced `(…)`/`{…}` span — the argument of `$(`, `<(`, `>(`, or
 * `${` — to its matching close, starting just past the OPENING bracket, and
 * returns the index right after that close (or `value.length` if it never
 * closes).
 *
 * Shared by every expansion form that glues onto the shell word this way,
 * because they all hide the same trap: an open/close character INSIDE A
 * QUOTE, inside the span, belongs to the substituted command, process, or
 * fallback value, not to this balancing (`$(printf ') value')` is one
 * substitution whose argument happens to contain a literal `)`, the same as
 * `${REALM:-'foo bar'}`'s fallback happening to contain neither bracket but
 * still needing quote-aware whitespace handling).  So a miniature quote
 * state rides along and only lets `open`/`close` move `depth` while no
 * quote is open, and a backslash steps over the character after it (outside
 * single quotes, where bash gives backslash no escaping power at all) so an
 * escaped quote or bracket cannot be misread as one either.
 *
 * A NESTED expansion inside the span is the same trap ONE LEVEL DEEPER, and
 * it is not covered by the quote state above — `$(printf %s ${X:-)x} tail)`
 * has no quotes in it at all, but the `)` inside `${X:-)x}`'s fallback
 * still belongs to that nested `${…}`, not to the outer `$(…)`'s own close.
 * So a nested `$(…)`, `${…}`, backtick span, `$'…'`, or `<(…)`/`>(…)` found
 * while walking is recursed into (or, for the quoted forms, walked to its
 * own close) as one atomic unit — its internal delimiters never reach this
 * level's `depth` at all, rather than being counted and hoping the count
 * still balances by coincidence.  Command and parameter substitution stay
 * LIVE inside a double-quoted segment of the span too (bash still expands
 * them there), so the quote-state branch recurses the same way; a single
 * quote, by contrast, makes everything up to its own close — even a
 * `$` — purely literal, exactly as bash treats it.  `budget` bounds how
 * many levels of THAT recursion are still allowed — see
 * `MAX_EXPANSION_NESTING` — and once it runs out, a nested opener is no
 * longer consumed atomically at all; its `(`/`{` character falls through
 * to the flat counting below like any other, which cannot crash and is
 * still correct for same-type nesting, just not for mismatched brackets
 * that deep.
 *
 * `case`/`esac` are shell KEYWORDS, not part of this balancing, and hide a
 * different trap that has nothing to do with quoting or nesting depth: a
 * `case` arm's pattern is closed by a BARE `)` with NO MATCHING `(` AT ALL
 * — `case x in x) printf foo;; esac` is valid inside `$(…)` (Bash manual,
 * `help case`), and counting that `)` as this level's own close is wrong
 * the same way a stray quote is wrong, just via shell grammar instead of
 * quoting.  While an open `case` body sits at THIS level's `depth` (no
 * subshell opened inside it since the `case` keyword), every bare `)` it
 * produces is a pattern terminator, not a close, tracked with a stack of
 * the depths at which `case` was seen; `esac` pops it, and a subshell
 * opened inside the body still balances normally because `(` and `)`
 * change `depth` as usual whenever it is above the `case`'s own depth. */
function walkBalancedSpan(value: string, openIndex: number, open: string, close: string, budget = MAX_EXPANSION_NESTING): number {
  let depth = 1;
  const caseStack: number[] = [];
  const atWordBoundaryBefore = (pos: number) => pos <= 0 || !/[A-Za-z0-9_]/.test(value.charAt(pos - 1));
  const atWordBoundaryAfter = (pos: number) => pos >= value.length || !/[A-Za-z0-9_]/.test(value.charAt(pos));
  let j = openIndex + 1;
  let innerQuote: string | undefined;
  while (j < value.length && depth > 0) {
    const inner = value.charAt(j);
    if (innerQuote === "'") {
      // single quotes are purely literal in bash — not even `$` starts an
      // expansion inside one, and there is no escape processing at all
      if (inner === "'") innerQuote = undefined;
      j += 1;
      continue;
    }
    if (innerQuote === '"') {
      if (inner === "\\" && j + 1 < value.length) {
        j += 2;
        continue;
      }
      if (inner === '"') {
        innerQuote = undefined;
        j += 1;
        continue;
      }
      // command and parameter substitution stay LIVE inside double quotes
      // in bash, so a NESTED expansion here is still one atomic unit whose
      // own delimiters must not be read as this level's — the same
      // "quoted or escaped doesn't count" rule this function exists for,
      // one quoting level in.  Beyond `budget`, fall through unconsumed —
      // see `MAX_EXPANSION_NESTING`.
      if (budget > 0 && inner === "$" && (value.charAt(j + 1) === "(" || value.charAt(j + 1) === "{")) {
        const nestedOpen = value.charAt(j + 1);
        j = walkBalancedSpan(value, j + 1, nestedOpen, nestedOpen === "(" ? ")" : "}", budget - 1);
        continue;
      }
      if (inner === "`") {
        j = walkBacktick(value, j);
        continue;
      }
      j += 1;
      continue;
    }
    // no quote currently open at this level
    if (inner === "'" || inner === '"') {
      innerQuote = inner;
      j += 1;
      continue;
    }
    if (inner === "\\" && j + 1 < value.length) {
      j += 2;
      continue;
    }
    // A NESTED expansion — `$(…)`, `${…}`, a backtick span, `<(…)`/`>(…)`
    // — is one atomic unit too, exactly like at the top level: its own
    // parens/braces belong to IT, not to this level's depth.  This is the
    // fix for the case that motivated recursing at all: a nested `${…}`
    // whose fallback contains a literal `)` (`$(printf %s ${X:-)x} tail)`)
    // must not have that `)` mistaken for THIS `$(…)`'s own close.  Beyond
    // `budget`, none of these three recursing branches consume atomically
    // any more — see `MAX_EXPANSION_NESTING`.
    if (budget > 0 && inner === "$" && (value.charAt(j + 1) === "(" || value.charAt(j + 1) === "{")) {
      const nestedOpen = value.charAt(j + 1);
      j = walkBalancedSpan(value, j + 1, nestedOpen, nestedOpen === "(" ? ")" : "}", budget - 1);
      continue;
    }
    if (inner === "$" && value.charAt(j + 1) === "'") {
      let k = j + 2;
      while (k < value.length) {
        if (value.charAt(k) === "\\" && k + 1 < value.length) {
          k += 2;
          continue;
        }
        if (value.charAt(k) === "'") {
          k += 1;
          break;
        }
        k += 1;
      }
      j = k;
      continue;
    }
    if (inner === "`") {
      j = walkBacktick(value, j);
      continue;
    }
    if (budget > 0 && (inner === "<" || inner === ">") && value.charAt(j + 1) === "(") {
      j = walkBalancedSpan(value, j + 1, "(", ")", budget - 1);
      continue;
    }
    // `case`/`esac` open and close a region where a bare `)` is a pattern
    // terminator, not this level's close — see the doc comment above.
    // Only meaningful for the paren form; `${…}`'s `case` (if any) is
    // somebody's literal fallback text, not shell grammar, since `case` is
    // never itself the CONTENTS of a parameter expansion's own syntax.
    if (open === "(" && close === ")") {
      if (inner === "c" && value.slice(j, j + 4) === "case" && atWordBoundaryBefore(j) && atWordBoundaryAfter(j + 4)) {
        caseStack.push(depth);
        j += 4;
        continue;
      }
      if (inner === "e" && value.slice(j, j + 4) === "esac" && atWordBoundaryBefore(j) && atWordBoundaryAfter(j + 4)) {
        if (caseStack.length > 0 && caseStack[caseStack.length - 1] === depth) caseStack.pop();
        j += 4;
        continue;
      }
      if (inner === ")" && caseStack.length > 0 && caseStack[caseStack.length - 1] === depth) {
        j += 1; // a case arm's pattern terminator — `depth` is untouched
        continue;
      }
    }
    if (inner === open) {
      depth += 1;
    } else if (inner === close) {
      depth -= 1;
    }
    j += 1;
  }
  return j;
}

function bareValueEnd(value: string, wrapper: Wrapper | undefined): number {
  if (!wrapper) return value.length;
  const runBefore = (pos: number): number => {
    let run = 0;
    while (pos - 1 - run >= 0 && value.charAt(pos - 1 - run) === "\\") run += 1;
    return run;
  };
  const isWrapperQuote = (pos: number): boolean => value.charAt(pos) === wrapper.quote && runBefore(pos) === wrapper.backslashes;

  let i = 0;
  while (i < value.length) {
    if (!isWrapperQuote(i)) {
      i += 1;
      continue;
    }
    const run = runBefore(i);
    const after = value.charAt(i + 1);
    const before = value.charAt(i - 1);
    const emptyInlineParam = after === wrapper.quote && before === "=";
    // A process substitution glues on too (`<(…)`/`>(…)` is replaced by a
    // filename, same as `$(…)` is replaced by output) — but a BARE `<`/`>`
    // not followed by `(` is a real redirection and must keep closing the
    // argument the way it always has, so only the paren-bearing form enters
    // the glued-run scan at all.
    const processSubst = (after === "<" || after === ">") && value.charAt(i + 2) === "(";
    if (after === "$" || after === "`" || emptyInlineParam || processSubst) {
      let j = i + 1;
      let atBoundary = false;
      while (j < value.length && !isWrapperQuote(j)) {
        const ch = value.charAt(j);
        // `$(…)` is replaced with its output before the shell word is
        // assembled, so whitespace inside it is never a word boundary —
        // walk the whole balanced span as one atomic unit (see
        // `walkBalancedSpan`).  `<(…)`/`>(…)` (process substitution,
        // replaced by a filename) glues on exactly the same way.
        if ((ch === "$" || ch === "<" || ch === ">") && value.charAt(j + 1) === "(") {
          j = walkBalancedSpan(value, j + 1, "(", ")");
          continue;
        }
        // `${…}` (parameter expansion) glues on the same way too — its
        // fallback/pattern operators (`${REALM:-'foo bar'}`) can carry
        // quoted whitespace of their own, so this is the brace-delimited
        // twin of the paren walk above, not a special case of it.
        if (ch === "$" && value.charAt(j + 1) === "{") {
          j = walkBalancedSpan(value, j + 1, "{", "}");
          continue;
        }
        // `$'…'` (ANSI-C quoting) is a QUOTED span, not a balanced-paren
        // one — bash processes its own backslash escapes, and `\'` inside
        // it is a literal quote, not the close — so whitespace inside is
        // never an outer boundary either, walked to its own matching quote.
        if (ch === "$" && value.charAt(j + 1) === "'") {
          let k = j + 2;
          while (k < value.length) {
            if (value.charAt(k) === "\\" && k + 1 < value.length) {
              k += 2;
              continue;
            }
            if (value.charAt(k) === "'") {
              k += 1;
              break;
            }
            k += 1;
          }
          j = k;
          continue;
        }
        // a backtick command substitution is the same story — its own
        // whitespace runs to the matching backtick, not to a boundary
        if (ch === "`") {
          j = walkBacktick(value, j);
          continue;
        }
        // a backslash-escaped character is glued to the run just as tightly
        // as `$(…)` or a backtick span — bash preserves whatever follows the
        // backslash literally, escaped whitespace included, so `$REALM\
        // value` is one shell word and the escaped space is not a boundary.
        // Consuming BOTH characters here (rather than only skipping the
        // backslash) is what keeps an escaped copy of the wrapper's own
        // quote character from being misread as a boundary or a close too.
        if (ch === "\\" && j + 1 < value.length) {
          j += 2;
          continue;
        }
        // whitespace or a shell separator ends the glued word right here —
        // a same-type quote somewhere further down the line belongs to
        // unrelated, later text, not to this run
        if (/[\s;&|]/.test(ch)) {
          atBoundary = true;
          break;
        }
        j += 1;
      }
      if (!atBoundary && j < value.length) {
        i = j + 1; // requoted — this candidate was not the close; scan past it
        continue;
      }
      return i - run; // the glued run ended — at a boundary or out of text — with no further quote behind it
    }
    const closes = after === "" || /[\s;&|<>)\]},'"]/.test(after);
    // the escaping backslashes belong to the delimiter, not to the credential
    return closes ? i - run : value.length;
  }
  return value.length;
}

/** Scheme words that justify a SHORT credential behind them.
 *
 * Spelled out here and nowhere else.  The patterns deliberately do not name
 * scheme words — a bare scheme word is a false-positive machine, and it is
 * the header NAME that makes one safe to cross — but this list creates no
 * match of its own; it only relaxes a floor for a match the header name has
 * already anchored.  The two uses are not the same risk. */
const SHORT_CREDENTIAL_SCHEMES = new Set([
  "basic",
  "bearer",
  "digest",
  "oauth",
  "token",
  "negotiate",
  "ntlm",
  "hawk",
  "mac",
  "apikey",
  "sso",
]);

/** How long a value has to be before it is worth masking.
 *
 * The eight-character floor is there to keep prose after a colon out of the
 * mask.  A REAL scheme retires that worry — `Basic dTpw` is `u:p`, and
 * measuring the floor against `dTpw` alone left it in the clear — but the
 * scheme group matches any short alphabetic token, so `<header>: not set`
 * offers `not` as a scheme and would have had `set` masked out of ordinary
 * bot text.  Only a scheme that really does carry short credentials lowers
 * the floor. */
const minMaskable = (scheme: string | undefined) =>
  scheme && SHORT_CREDENTIAL_SCHEMES.has(scheme.trim().toLowerCase()) ? 1 : 8;

/** A documentation placeholder, not a credential.
 *
 * Two shapes.  Bracketed — `<token>`, `{api-key}`, `[YOUR_TOKEN]` — where
 * nothing real is ever spelled that way, so length does not matter.  And the
 * bare noun a sentence uses when it means "put yours here": `<scheme> token`,
 * `<scheme> secret`, `<scheme> your-api-key`.  Those are only reachable
 * because a known scheme lowers the floor, which is exactly the case the
 * eight-character floor used to cover by accident.
 *
 * It matters because this function runs over persisted bot text and routine
 * instructions as well as over headers, and masking the guidance corrupts
 * what a reader was told to do.  A real credential that happens to BE the
 * word `token` is not a credential worth protecting. */
const PLACEHOLDER_WORDS = new Set([
  "token",
  "tokens",
  "secret",
  "key",
  "apikey",
  "api_key",
  "api-key",
  "credential",
  "credentials",
  "password",
  "passwd",
  "value",
  "placeholder",
  "changeme",
  "redacted",
  "none",
  "null",
  "blank",
  "empty",
]);

/** Instruction verbs a sentence uses to introduce a placeholder — "Use
 * Authorization: Bearer token.", "Set Authorization: Bearer secret".  Kept to
 * a small closed set for the same reason the scheme list is: a MARKER has to
 * do the work, not a guess, or "curl failed: Authorization: Bearer password"
 * would read "failed:" as an instruction and exempt a real credential too.
 * Checked only against the FIRST word of the CLAUSE the header sits in —
 * see `hasPlaceholderLeadIn`. */
const PLACEHOLDER_LEAD_WORDS = new Set(["use", "set", "send", "add", "include", "provide", "pass", "specify"]);

/** Does the CLAUSE this match sits in open with a recognised instruction
 * verb?  Whitespace apart, same as `wrapperQuoteAt` — the verb has to
 * actually introduce this sentence, not merely appear somewhere earlier in
 * the transcript.
 *
 * A clause, not the whole line: `set` is also a bash BUILTIN, and a
 * recorded command line can run several of them before the one that
 * actually carries the header — `set -x; curl -H "Authorization: Bearer
 * password"` has `set` as the line's first word, but it introduces shell
 * setup, not this sentence.  Reading the line's first word as the lead-in
 * exempted the real credential that followed an unrelated earlier command.
 * So this looks only as far back as the nearest shell separator — `;`,
 * `&`, `|`, or a newline, whichever is closest — and takes the first word
 * after THAT as the one that has to be a recognised verb.
 *
 * That still is not enough for `set` on its own, though: nothing separates
 * a DIRECT invocation from prose when it genuinely IS the clause's first
 * word — `set -- Authorization: Bearer password` (Bash assigns those
 * arguments to positional parameters, `help set`) begins its own clause
 * with `set` exactly the way `Set Authorization: Bearer <token>` does.
 * What tells them apart is the SECOND word: a real invocation's is always
 * an option flag (`-x`, `-e`, `--`, …), which an instruction sentence
 * never writes right after the verb.  Gating on that keeps `set` as a
 * lead-in for prose while refusing it for an actual builtin call — the
 * other lead-in verbs need no such check because none of them doubles as
 * a bash builtin that takes flags this way. */
function hasPlaceholderLeadIn(before: string): boolean {
  let clauseStart = 0;
  for (const sep of [";", "&", "|", "\n"]) {
    const idx = before.lastIndexOf(sep) + 1;
    if (idx > clauseStart) clauseStart = idx;
  }
  const words = before.slice(clauseStart).trim().split(/\s+/);
  const firstWord = words[0];
  if (!firstWord) return false;
  const normalized = firstWord.toLowerCase().replace(/[^a-z]/g, "");
  if (!PLACEHOLDER_LEAD_WORDS.has(normalized)) return false;
  if (normalized === "set" && words[1]?.startsWith("-")) return false;
  return true;
}

/** `leadIn` says whether an instruction verb ("Use", "Set", …) opens the
 * sentence this value sits in — see `hasPlaceholderLeadIn`.  It gates the
 * BARE-noun branch and the FILLER branch (`xxxx`, `****`, `…`) below; the
 * bracketed and prefixed shapes carry their own unambiguous marker in the
 * text itself and need no sentence context to be trusted.  A run of nothing
 * but `x`/`*`/`.`/`…` LOOKS like a placeholder, but it is also a perfectly
 * syntactically valid Bearer token — `Authorization: Bearer xxxxxxxxxxxx`
 * reads exactly like real masked-looking prose unless something in the
 * sentence actually says so, the same reasoning that already gates the
 * bare-noun branch.
 *
 * `precedingWord` is whatever the AUTH_HEADER patterns' own optional `scheme`
 * group captured immediately before this value, when they captured anything
 * at all — and it matters here for a reason that has nothing to do with a
 * scheme.  That group is any short alphabetic word followed by whitespace,
 * so on a status sentence like `Authorization: not provided` it captures
 * `not` as if it were a scheme and hands this function only `provided` —
 * ONE status word, indistinguishable on its own from a real one-word Bearer
 * value.  Folding `precedingWord` back in when IT is itself a status word
 * reassembles the sentence the regex split apart, so `not provided` is still
 * read as two words and `Bearer configured` is read as the one bare word it
 * actually is. */
const isPlaceholder = (value: string, leadIn: boolean, precedingWord?: string) => {
  // trailing sentence punctuation belongs to the prose, not to the
  // placeholder — `Use <header>: <scheme> token.` is still guidance.  Only
  // punctuation no credential ends in is stripped: `=` stays, because base64
  // padding is real, and so does `.`, unless what is left is a placeholder
  // anyway, which no JWT segment ever is.
  const trimmed = value.trim().replace(/[.,;:!?]+$/, "") || value.trim();
  if (/^[<{[][^\s<>{}[\]]*[>}\]]$/.test(trimmed)) return true; // bracketed
  // xxxx, ****, … — needs a recognised lead-in the same as the bare noun
  // below, because unlike the bracketed shape this one is ALSO a real,
  // syntactically valid credential and nothing in the text marks it as
  // documentation on its own
  if (leadIn && /^[x*.\u2026]+$/i.test(trimmed)) return true;
  const word = trimmed.toLowerCase();
  // A `your`/`my` prefix only counts when a SEPARATOR follows it.
  // `your-api-key` and `your_token` are documentation; `yourtoken` and
  // `mysecret` are things somebody might actually have set, and exempting
  // those would hand a real credential straight through.  The prefix IS the
  // marker here, so this branch needs no sentence context of its own.
  const unprefixed = word.replace(/^(?:your|my|the)[-_]/, "");
  if (unprefixed !== word && PLACEHOLDER_WORDS.has(unprefixed)) return true;
  // An EXACT, unprefixed placeholder word — `token`, `secret`, `password` on
  // its own — carries no marker in the text at all: `Use … Bearer token.` and
  // `Authorization: Bearer password` (someone's actual, bad password) read
  // identically once the header has already anchored the match down to this
  // one word.  Only the sentence around it tells them apart, so this branch
  // is reachable only with a recognised lead-in verb — otherwise the word is
  // treated as a real, masked credential, the same as before the placeholder
  // exemption existed.
  if (leadIn && PLACEHOLDER_WORDS.has(word)) return true;
  // A status sentence is not a credential either: `no value`, `not provided`,
  // `missing`.  Every word has to be one of these, so no credential with a
  // space in it can pass — and a credential is one token anyway.  But a
  // SINGLE status word is not a sentence, and several of them — `configured`,
  // `provided`, `available` — are also syntactically ordinary Bearer tokens:
  // `Authorization: Bearer configured` is exactly as plausible a credential
  // as `Authorization: Bearer <anything-else-that-long>`, and nothing in the
  // text marks it as prose the way a second word ("was configured", "not
  // provided") does.  Requiring more than one word is what makes this an
  // unmistakable STATUS SENTENCE rather than a guess at one unmarked word;
  // a lone status word falls through and is masked like any other credential
  // — unless the word right before it was ALSO a status word that the
  // scheme group swallowed, in which case the sentence was multiword all
  // along and this reassembles it before judging.
  const lead = precedingWord?.trim().toLowerCase();
  const parts = lead && STATUS_WORDS.has(lead) ? [lead, ...word.split(/\s+/)] : word.split(/\s+/);
  return parts.length > 1 && parts.every((part) => STATUS_WORDS.has(part));
};

/** Words a status sentence is made of, where a credential would be. */
const STATUS_WORDS = new Set([
  "no",
  "not",
  "none",
  "never",
  "nil",
  "null",
  "missing",
  "absent",
  "unset",
  "empty",
  "blank",
  "provided",
  "present",
  "configured",
  "set",
  "sent",
  "found",
  "yet",
  "value",
  "header",
  "required",
  "available",
  "was",
  "is",
  "a",
  "any",
  "the",
]);

const PEM_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----|$)/g;
/** key=value / key: value / key="value" where the key is secret-shaped.
 * The value must be a single token of some length; prose after a colon
 * ("password: leave blank…") has spaces and does not match.
 *
 * `authorization` is deliberately NOT in this list: the two AUTH_HEADER
 * patterns above own that key end to end, and running both would mask the
 * scheme they had just kept on purpose (`AWS4-HMAC-SHA256` is a long enough
 * token to look like a value to this pattern).  The unterminated variant
 * below keeps it, because that one runs only where neither of them can
 * match at all — a quote that was opened and never closed. */
const KEY_VALUE =
  /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;
/** The same key list, for a value whose CLOSING quote was lost upstream.
 * `KEY_VALUE` needs `\3` to close the value, so `{"api_key":"<300 chars>"}`
 * clipped to 240 characters matches nothing and the key material goes out
 * intact.  Anchored at end-of-text, because that is the only place a quote
 * that never closes can legitimately come from: something cut the string.
 * The value class is deliberately wide (anything but a quote) — over-redacting
 * the tail of a string that was already truncated costs a reader nothing. */
const KEY_VALUE_UNTERMINATED =
  /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["'])([^"']{8,})$/i;

/** Text that is nothing but masks already.
 *
 * Redaction runs twice by design — once in `describeResult()` before the
 * clip, once in the Sentry observer for a detail that arrived some other way
 * — and a second pass must not mask a mask, because it would then report the
 * marker's length instead of the secret's, and the length is the part a
 * reader debugs with.
 *
 * WHOLLY masked, not "contains a mask", and the distinction is load-bearing:
 * a value that is only partly masked still has a live secret in the rest of
 * it, so it must go through the pass again.  That is why this is not a
 * `includes()` check — a SigV4 header whose `AKIA…` had been masked by the
 * prefix pass would have looked "already done" and shipped its signature. */
const WHOLLY_MASKED = /^[\s,;]*(?:«redacted \d+ chars»[\s,;]*)+$/;

export function redactSecretsInText(text: string): string {
  if (!text || text.length < 8) return text;
  let out = text;
  out = out.replace(PEM_BLOCK, (m, open: string, body: string, close: string) => {
    const trimmed = body.trim();
    if (WHOLLY_MASKED.test(trimmed)) return m; // already redacted; keep the reported length
    if (!trimmed && !close) return open;
    const masked = mask(trimmed);
    return close ? `${open}\n${masked}\n${close}` : `${open}\n${masked}`;
  });
  // The authorization header goes FIRST, before the prefix pass.  Its value
  // is a whole credential, and a prefix pass that had already masked one part
  // of it (SigV4 carries an `AKIA…` access-key id before the signature) would
  // leave a partly-masked value behind for this pass to trip over.
  //
  // Quote-introduced first, bare second.  They cannot both claim the same
  // header — the bare one refuses a value that opens with a quote — so the
  // order is only about reading the two rules in the order they are written.
  // Both keep a value that is WHOLLY masked already, and both decline a value
  // too short to be a credential rather than masking the prose after a colon.
  out = out.replace(
    AUTH_HEADER_QUOTED,
    (m, key: string, sep: string, quote: string, scheme: string | undefined, value: string, close: string, offset: number, whole: string) => {
      // A value that ran to the end of the text lost its closing quote to a
      // clip, and the scheme goes INSIDE the mask on that path alone.  That
      // is not cosmetic: `KEY_VALUE_UNTERMINATED` still lists `authorization`
      // and still sees this shape, and only a WHOLLY masked value makes it
      // stand down — a `Basic «redacted …»` left behind would be masked a
      // second time and would then report the marker's length instead of the
      // secret's.  Masking scheme and value together reproduces, byte for
      // byte, what that pass produced before this one could reach the shape.
      const body = close ? value : `${scheme ?? ""}${value}`;
      // scheme is already folded into `body` on the unterminated path — pass
      // it separately only when it still stands apart from the value
      if (
        body.length < minMaskable(scheme) ||
        WHOLLY_MASKED.test(body) ||
        isPlaceholder(body, hasPlaceholderLeadIn(whole.slice(0, offset)), close ? scheme : undefined)
      )
        return m;
      const kept = close ? (scheme ?? "") : "";
      return `${key}${sep}${quote}${kept}${mask(body)}${close}`;
    },
  );
  out = out.replace(
    AUTH_HEADER_BARE,
    (m, key: string, sep: string, scheme: string | undefined, value: string, offset: number, whole: string) => {
      // trailing blanks are the line's, not the credential's, so they stay
      // outside the mask and out of the length it reports
      const end = bareValueEnd(value, wrapperQuoteAt(whole, offset));
      // trailing blanks are the line's, not the credential's, so they stay
      // outside the mask and out of the length it reports
      const credential = value.slice(0, end).replace(/[^\S\r\n]+$/, "");
      if (
        credential.length < minMaskable(scheme) ||
        WHOLLY_MASKED.test(credential) ||
        isPlaceholder(credential, hasPlaceholderLeadIn(whole.slice(0, offset)), scheme)
      )
        return m;
      return `${key}${sep}${scheme ?? ""}${mask(credential)}${value.slice(credential.length)}`;
    },
  );
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  // the same placeholder rule applies to a scheme word standing on its own:
  // `<scheme> your-api-key` in a routine's instructions is guidance, not a
  // credential, and this pass reaches persisted bot text too
  out = out.replace(BEARER, (m, lead: string, tok: string, offset: number, whole: string) =>
    isPlaceholder(tok, hasPlaceholderLeadIn(whole.slice(0, offset))) ? m : `${lead}${mask(tok)}`,
  );
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`);
  out = out.replace(KEY_VALUE_UNTERMINATED, (m, key: string, sep: string, quote: string, value: string) =>
    WHOLLY_MASKED.test(value) ? m : `${key}${sep}${quote}${mask(value)}`,
  );
  return out;
}

/** The walk both public deep redactors share.  `text` is what every string
 * that is NOT under a secret-shaped key goes through: the plain content pass
 * for `redactSecrets`, the cap-then-content pass for `redactSecretsForLog`.  A
 * secret-shaped key is masked outright either way, so a caller can never widen
 * what a known credential field reports. */
function redactTree(input: unknown, depth: number, text: (value: string) => string): unknown {
  if (typeof input === "string") return text(input);
  if (depth > 12 || input === null || typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => {
      // ACP env entries: {name: "OMB_COMMS_TOKEN", value: "…"}
      if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { value?: unknown }).value === "string"
      ) {
        const entry = item as { name: string; value: string };
        // A non-secret-shaped name (a custom env var, a feature flag) does
        // not clear the value of suspicion — the same content pass every
        // other string in this tree gets is what catches a credential
        // someone stashed under an ordinary-looking name.
        return isSecretName(entry.name) ? { ...entry, value: mask(entry.value) } : { ...entry, value: text(entry.value) };
      }
      return redactTree(item, depth + 1, text);
    });
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && isSecretName(key)) {
      out[key] = mask(value);
      continue;
    }
    // any other string may still CONTAIN a credential (a command line, a
    // header value, a bot's reply) — the content pass catches those
    out[key] = redactTree(value, depth + 1, text);
  }
  return out;
}

/** Deep copy with credential VALUES replaced.  Handles the two shapes that
 * actually carry them: a plain object of env vars ({KEY: "v"}) and the ACP
 * wire shape (env: [{name, value}]).  Anything unrecognised is copied as-is. */
export function redactSecrets(input: unknown, depth = 0): unknown {
  return redactTree(input, depth, redactSecretsInText);
}

/** Cap on how much of one string the canonical event log keeps.
 *
 * The unit is UTF-16 code units rather than bytes on purpose: `String.length`
 * is O(1) where a byte count is a scan of the very string the cap exists to
 * avoid scanning, and code units bound the regex work exactly, which is the
 * whole point.  The marker reports the same unit it cut in.
 *
 * 256 KB is three orders of magnitude more than a human reads out of one log
 * record and two orders below the tool results that made the tee the harness's
 * hottest path: a 5 MB `read_file` body used to run through every pattern in
 * this file, on the main thread, while every other bot's turn, the SSE
 * fan-out and `/api/health` waited behind it. */
export const LOG_TEE_MAX_STRING_CHARS = 256 * 1024;

/** Content pass for the log tee: redact, THEN cut.
 *
 * The order is load-bearing and is the reason this is not "slice and call
 * `redactSecretsInText`".  `KEY_VALUE_UNTERMINATED` exists because a
 * credential whose closing quote was lost to a clip is still a credential, and
 * it anchors at end-of-text — so the head has to be redacted while the clip is
 * still the last thing in the string.  Cutting first would end it in a marker
 * instead, and a secret straddling the boundary would ship its prefix in the
 * clear.
 *
 * The elided tail is never written, redacted or not, so nothing in it can
 * leak.  A string within the cap takes exactly the path it took before this
 * function existed. */
export function redactSecretsInLogText(text: string, maxChars = LOG_TEE_MAX_STRING_CHARS): string {
  if (text.length <= maxChars) return redactSecretsInText(text);
  const elided = text.length - maxChars;
  return `${redactSecretsInText(text.slice(0, maxChars))}[… ${elided} characters elided from log]`;
}

/** `redactSecrets` for a destination that is a log file rather than a live
 * consumer: identical tree, identical masking, plus a per-string length cap so
 * the cost of redacting one event is bounded by the cap and the shape of the
 * event instead of by the size of whatever a tool just read. */
export function redactSecretsForLog(input: unknown, maxChars = LOG_TEE_MAX_STRING_CHARS): unknown {
  return redactTree(input, 0, (value) => redactSecretsInLogText(value, maxChars));
}
