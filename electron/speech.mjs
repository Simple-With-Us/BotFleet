// Speech helper lifecycle, main-process side. The Swift recognizer is a tiny
// background app because current macOS privacy enforcement requires the code
// calling Speech/AVFoundation to be launched with its own Info.plist identity.
// Compiled lazily in development; each recording session is one helper app.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

import {
  buildSpeechHelper,
  speechHelperBinary,
  speechHelperBundle,
} from "./build-speech-helper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "resources", "speech-helper.swift");
const INFO = path.join(__dirname, "resources", "speech-helper-Info.plist");
// Packaged: the helper bundle ships pre-built + signed in Resources. A signed
// app bundle must never be rewritten — lazy compilation would break its seal.
const BUNDLE = app.isPackaged
  ? path.join(process.resourcesPath, "BotFleet Speech.app")
  : speechHelperBundle;
const BIN = app.isPackaged
  ? path.join(BUNDLE, "Contents", "MacOS", "speech-helper")
  : speechHelperBinary;

let child = null;

function ensureBuilt() {
  if (app.isPackaged) return;
  const binaryMtime = existsSync(BIN) ? statSync(BIN).mtimeMs : 0;
  const stale = binaryMtime < Math.max(statSync(SRC).mtimeMs, statSync(INFO).mtimeMs);
  if (!stale) return;
  buildSpeechHelper();
}

function sendEnd(win, info) {
  if (!win.isDestroyed()) win.webContents.send("speech:end", info);
}

/**
 * Start one recognition session. `endpointMs` is call-mode-only: composer
 * dictation deliberately keeps listening until its mic button is pressed.
 */
export function startSpeech(win, options = {}) {
  stopSpeech();
  if (process.platform !== "darwin") {
    sendEnd(win, { code: 2, reason: "unsupported-platform" });
    return;
  }
  const requested = Number(options?.endpointMs);
  const endpointMs = Number.isFinite(requested) && requested > 0
    ? Math.min(5_000, Math.max(250, Math.round(requested)))
    : 0;
  const args = endpointMs ? ["--endpoint-ms", String(endpointMs)] : [];

  try {
    ensureBuilt();
  } catch {
    sendEnd(win, { code: 1, reason: "helper-build-failed" });
    return;
  }

  // A direct spawn of Contents/MacOS/speech-helper loses the app-bundle
  // identity and TCC kills it for lacking a usage description. LaunchServices
  // preserves that identity. `open` redirects its stdout/stderr to files,
  // which we tail to retain the helper's NDJSON streaming contract.
  const sessionDir = mkdtempSync(path.join(app.getPath("temp"), "botfleet-speech-"));
  const outputPath = path.join(sessionDir, "stdout.ndjson");
  const errorPath = path.join(sessionDir, "stderr.log");
  const stopPath = path.join(sessionDir, "stop");
  const finishPath = path.join(sessionDir, "finish");
  writeFileSync(outputPath, "");
  writeFileSync(errorPath, "");

  let proc;
  try {
    proc = spawn(
      "/usr/bin/open",
      [
        "-n",
        "-g",
        "-W",
        "-o",
        outputPath,
        "--stderr",
        errorPath,
        BUNDLE,
        "--args",
        ...args,
        "--stop-file",
        stopPath,
        "--finish-file",
        finishPath,
      ],
      { stdio: "ignore" },
    );
  } catch {
    rmSync(sessionDir, { recursive: true, force: true });
    sendEnd(win, { code: 1, reason: "helper-start-failed" });
    return;
  }

  const speechSession = { proc, outputPath, errorPath, stopPath, finishPath, sessionDir };
  child = speechSession;
  let buf = "";
  let offset = 0;
  let reportedError = null;
  let completed = false;

  const drain = () => {
    let content;
    try {
      content = readFileSync(outputPath, "utf8");
    } catch {
      return;
    }
    if (content.length <= offset) return;
    buf += content.slice(offset);
    offset = content.length;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.error === "string") reportedError = parsed.error;
        if (parsed.partial === false && typeof parsed.text === "string") completed = true;
        // A stopped/replaced helper can flush one last chunk. Never leak it
        // into the session that replaced it.
        if (child === speechSession && !win.isDestroyed()) {
          win.webContents.send("speech:transcript", parsed);
        }
      } catch {
        /* non-JSON noise on stdout — ignore */
      }
    }
  };
  watchFile(outputPath, { interval: 50, persistent: false }, drain);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unwatchFile(outputPath, drain);
    rmSync(sessionDir, { recursive: true, force: true });
  };
  proc.on("close", (code) => {
    drain();
    cleanup();
    // stopSpeech() clears child before creating the stop marker. Suppressing
    // that close event is essential in call mode: intentional TTS muting must
    // not look like the natural end of a spoken turn.
    if (child !== speechSession) return;
    child = null;
    if (reportedError) {
      sendEnd(win, { code: 1, reason: reportedError });
    } else if (completed && code === 0) {
      sendEnd(win, { code: 0, reason: "completed" });
    } else {
      sendEnd(win, { code: 1, reason: "helper-exited" });
    }
  });
  proc.on("error", () => {
    cleanup();
    if (child !== speechSession) return;
    child = null;
    sendEnd(win, { code: 1, reason: "helper-start-failed" });
  });
}

export function stopSpeech() {
  if (!child) return;
  const speechSession = child;
  child = null;
  try {
    writeFileSync(speechSession.stopPath, "stop");
  } catch {}
}

/** Finalize the active request and keep it owned until the recognizer emits
 * its final transcript. Used by push-to-talk key release. */
export function finishSpeech() {
  if (!child) return;
  try {
    writeFileSync(child.finishPath, "finish");
  } catch {}
}

let personalVoiceChild = null;

// A Personal Voice utterance is synthesised on-device at roughly 15 characters
// per second, so budget generously per character and keep a floor for a short
// reply whose synthesizer never calls back at all.
const PERSONAL_VOICE_MIN_MS = 15_000;
const PERSONAL_VOICE_MS_PER_CHAR = 250;
// Listing can park forever in requestPersonalVoiceAuthorization when the TCC
// prompt never surfaces to the background-only helper.  Past this, answer with
// an empty list and stop the helper.
const PERSONAL_VOICE_LIST_TIMEOUT_MS = 8_000;
// Range lines are tailed from the helper's stdout file while it speaks.
const PERSONAL_VOICE_POLL_MS = 40;

/**
 * Tail an NDJSON file the helper appends to.  Reads raw bytes and only
 * decodes complete lines, so a read that lands mid-line (or mid-character)
 * never produces a broken record.  Returns a drain function.
 */
function ndjsonTail(filePath, onRecord) {
  let offset = 0;
  let pending = Buffer.alloc(0);
  return () => {
    let content;
    try {
      content = readFileSync(filePath);
    } catch {
      return;
    }
    if (content.length <= offset) return;
    pending = Buffer.concat([pending, content.subarray(offset)]);
    offset = content.length;
    let nl;
    while ((nl = pending.indexOf(0x0a)) !== -1) {
      const line = pending.subarray(0, nl).toString("utf8").trim();
      pending = pending.subarray(nl + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // non-JSON noise on stdout
      }
      onRecord(parsed);
    }
  };
}

/**
 * List this Mac's Personal Voices.  Resolves `{ voices, status, timedOut }`
 * and never rejects: a helper that cannot run, answers garbage, or does not
 * answer within `timeoutMs` (it can park waiting on authorization) yields an
 * empty list.  On timeout the helper is stopped through its stop marker,
 * since killing `open -W` would not kill it.
 */
export function listPersonalVoicesResult({ timeoutMs = PERSONAL_VOICE_LIST_TIMEOUT_MS } = {}) {
  if (process.platform !== "darwin") {
    return Promise.resolve({ voices: [], status: "unsupported", timedOut: false });
  }
  try {
    ensureBuilt();
  } catch {
    return Promise.resolve({ voices: [], status: "helper-build-failed", timedOut: false });
  }
  return new Promise((resolve) => {
    const sessionDir = mkdtempSync(path.join(app.getPath("temp"), "botfleet-pv-list-"));
    const outputPath = path.join(sessionDir, "stdout.ndjson");
    const errorPath = path.join(sessionDir, "stderr.log");
    const stopPath = path.join(sessionDir, "stop");
    writeFileSync(outputPath, "");
    writeFileSync(errorPath, "");

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      // The helper's stop timer exits on this marker; the close handler still
      // owns removing the session directory.
      try {
        writeFileSync(stopPath, "stop");
      } catch {}
      settle({ voices: [], status: "timeout", timedOut: true });
    }, Math.max(0, timeoutMs));
    timer.unref?.();

    let proc;
    try {
      proc = spawn(
        "/usr/bin/open",
        [
          "-n",
          "-g",
          "-W",
          "-o",
          outputPath,
          "--stderr",
          errorPath,
          BUNDLE,
          "--args",
          "--list-personal-voices",
          "--stop-file",
          stopPath,
        ],
        { stdio: "ignore" },
      );
    } catch {
      rmSync(sessionDir, { recursive: true, force: true });
      settle({ voices: [], status: "helper-start-failed", timedOut: false });
      return;
    }

    proc.on("close", () => {
      let result = { voices: [], status: "no-answer", timedOut: false };
      try {
        const out = readFileSync(outputPath, "utf8").trim();
        for (const line of out.split("\n")) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line);
          if (Array.isArray(parsed.voices)) {
            result = {
              voices: parsed.voices,
              status: typeof parsed.status === "string" ? parsed.status : "authorized",
              timedOut: false,
            };
            break;
          }
        }
      } catch {}
      rmSync(sessionDir, { recursive: true, force: true });
      settle(result);
    });

    proc.on("error", () => {
      rmSync(sessionDir, { recursive: true, force: true });
      settle({ voices: [], status: "helper-start-failed", timedOut: false });
    });
  });
}

/** The renderer-facing list: a plain array, empty on any failure or timeout. */
export async function listPersonalVoices(options) {
  return (await listPersonalVoicesResult(options)).voices;
}

/** The longest reply the renderer will read aloud (MAX_LOCAL_SPEECH_CHARS in
 * src/lib/tts/index.ts).  The speaking deadline grows with the text, so an
 * unbounded request would also be an unbounded wait. */
export const MAX_PERSONAL_VOICE_TEXT_CHARS = 12_000;
const MAX_PERSONAL_VOICE_ID_CHARS = 256;

function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/* oxlint-disable anti-slop/no-runtime-typeof */
/**
 * The renderer chooses the text and the voice id, so the main process checks
 * them before it spawns anything: a string of text that is not blank and not
 * longer than a reply can be, and a voice id that is a string, short, free of
 * control characters, and either empty (the caller named no voice, so the
 * helper picks the first Personal Voice) or a `personal:` or `apple-personal:`
 * id.  A plain voice name such as `Samantha` is not a Personal Voice id and is
 * refused here, as the helper also refuses to match an ordinary voice.
 * Hand-written guards: the packaged app has no node_modules for a schema.
 */
export function validatePersonalVoiceRequest(text, voiceIdOrNone) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "Personal Voice needs some text to speak." };
  }
  if (text.length > MAX_PERSONAL_VOICE_TEXT_CHARS) {
    return { ok: false, error: "That text is too long to read aloud." };
  }
  // The bridge declares the id optional (`speak(text, voiceId?, options?)`), and a call
  // without one has always meant "no voice named", so a missing id is the empty id.
  const voiceId = voiceIdOrNone ?? "";
  if (
    typeof voiceId !== "string"
    || voiceId.length > MAX_PERSONAL_VOICE_ID_CHARS
    || hasControlCharacter(voiceId)
    || (voiceId !== "" && !/^(?:apple-)?personal:/.test(voiceId))
  ) {
    return { ok: false, error: "That is not a Personal Voice id." };
  }
  return { ok: true, text, voiceId };
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/**
 * Speak `text` with a Personal Voice.  `options.onRange({ location, length,
 * elapsedMs })` is called as each word is about to be spoken: `location` and
 * `length` are UTF-16 offsets into `text` exactly as passed (so a JavaScript
 * string index), and `elapsedMs` is the helper's own clock since speech
 * began, which lets a caller undo the polling delay when lines arrive in a
 * batch.  Ranges from a stopped or replaced session are never delivered.
 */
export function speakPersonalVoice(text, voiceId, options = {}) {
  // Validate before anything else: a bad request must not cut off the speech
  // already in progress, write files, or spawn a process.
  const request = validatePersonalVoiceRequest(text, voiceId);
  if (!request.ok) return Promise.reject(new Error(request.error));
  stopPersonalVoice();
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("Personal Voice requires macOS."));
  }
  try {
    ensureBuilt();
  } catch {
    return Promise.reject(new Error("The speech helper couldn't be built."));
  }
  const onRange = typeof options?.onRange === "function" ? options.onRange : null;

  return new Promise((resolve, reject) => {
    const sessionDir = mkdtempSync(path.join(app.getPath("temp"), "botfleet-pv-speak-"));
    const outputPath = path.join(sessionDir, "stdout.ndjson");
    const errorPath = path.join(sessionDir, "stderr.log");
    const stopPath = path.join(sessionDir, "stop");
    // argv is world-readable through `ps`, and this text is the bot's reply —
    // a voice summary of the user's own private messages. Only the path goes
    // on the command line; the text itself lives in a 0600 file inside a
    // 0700 mkdtemp directory, exactly as the stop/finish markers do.
    const textPath = path.join(sessionDir, "text.txt");
    writeFileSync(outputPath, "");
    writeFileSync(errorPath, "");
    writeFileSync(textPath, request.text, { mode: 0o600 });

    const proc = spawn(
      "/usr/bin/open",
      [
        "-n",
        "-g",
        "-W",
        "-o",
        outputPath,
        "--stderr",
        errorPath,
        BUNDLE,
        "--args",
        "--speak-personal-voice",
        "--voice-id",
        request.voiceId,
        "--text-file",
        textPath,
        "--stop-file",
        stopPath,
      ],
      { stdio: "ignore" },
    );

    const session = { proc, stopPath, sessionDir, textPath };
    personalVoiceChild = session;

    // Read the helper's lines as they land rather than only at exit, so word
    // ranges reach the caller while the word is being spoken.
    let reportedError = null;
    const drain = ndjsonTail(outputPath, (parsed) => {
      if (typeof parsed.error === "string" && reportedError === null) reportedError = parsed.error;
      const range = parsed.range;
      if (
        onRange
        && personalVoiceChild === session
        && Array.isArray(range)
        && Number.isSafeInteger(range[0])
        && Number.isSafeInteger(range[1])
        && range[0] >= 0
        && range[1] >= 0
      ) {
        const elapsedMs = Number.isFinite(parsed.elapsedMs) ? parsed.elapsedMs : null;
        try {
          onRange({ location: range[0], length: range[1], elapsedMs });
        } catch {
          /* a listener's failure must not end the speech */
        }
      }
    });
    let pollTimer = null;
    if (onRange) {
      watchFile(outputPath, { interval: PERSONAL_VOICE_POLL_MS, persistent: false }, drain);
      // watchFile alone can miss updates when the macOS CI runner's event loop is
      // saturated by the full vitest suite; interval polling keeps ranges timely.
      drain();
      pollTimer = setInterval(drain, PERSONAL_VOICE_POLL_MS);
      pollTimer.unref?.();
    }

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    // The helper parks in RunLoop.main.run() until the synthesizer delegate
    // fires or the stop marker appears, and the Personal Voice TCC prompt may
    // never surface to an LSBackgroundOnly bundle. Without a deadline the
    // promise never settles, the call queue never drains, and the session can
    // neither speak nor listen again. Sized off the text so a long reply still
    // gets room, with a floor for a reply that produces no audio at all.
    const budgetMs = Math.max(PERSONAL_VOICE_MIN_MS, String(text ?? "").length * PERSONAL_VOICE_MS_PER_CHAR);
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      // Keep the session registered: the helper can only be stopped through the
      // marker, and the close handler owns the sessionDir cleanup.
      try {
        writeFileSync(stopPath, "stop");
      } catch {}
      settle(() => reject(new Error("Personal Voice did not finish speaking.")));
    }, budgetMs);
    timer.unref?.();

    proc.on("close", () => {
      stopPolling();
      if (onRange) unwatchFile(outputPath, drain);
      drain();
      if (personalVoiceChild === session) personalVoiceChild = null;
      rmSync(sessionDir, { recursive: true, force: true });
      // {"finished":true}, or a stopped helper that exits quietly: both
      // resolve.  Only a reported error rejects.
      if (reportedError) settle(() => reject(new Error(reportedError)));
      else settle(resolve);
    });

    proc.on("error", (err) => {
      stopPolling();
      if (onRange) unwatchFile(outputPath, drain);
      if (personalVoiceChild === session) personalVoiceChild = null;
      rmSync(sessionDir, { recursive: true, force: true });
      settle(() => reject(err));
    });
  });
}

export function stopPersonalVoice() {
  if (personalVoiceChild) {
    try {
      writeFileSync(personalVoiceChild.stopPath, "stop");
    } catch {}
    personalVoiceChild = null;
  }
}

