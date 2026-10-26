#!/usr/bin/env node
/**
 * Build a one-file animated avatar.
 *
 * The author keeps a folder of source frames and one manifest; this turns
 * them into the single animated WebP that BotFleet plays, with the manifest
 * embedded inside the file so the handoff is one file and not two.
 *
 * The build is deliberately picky and says why when it refuses, because the
 * mistakes it catches are the ones that look fine in a folder and break
 * only on screen:
 *
 *   - the frame count in the manifest must match the frames on disk, because
 *     the manifest is what says which frame range is which animation;
 *   - every frame range must land inside the frames that exist, because a
 *     range that points past the end plays nothing;
 *   - every frame must be the same size, because the player draws one frame
 *     at a time and a ragged sequence would jump;
 *   - the file is scaled to the size the manifest declares, so a 1408x1408
 *     source does not become a 1408x1408 avatar that nobody will ever see
 *     larger than 44 pixels.
 *
 * The manifest that goes inside the file describes the FILE, not the folder.
 * Those are usually the same thing, and they are not the same when the
 * encoder folds a frame that looks exactly like the one before it into that
 * one, holding it for twice as long.  That happens whenever an animation
 * holds one pose for more than a frame, so it is ordinary rather than a
 * mistake, and the tool maps the author's frame numbers onto the frames the
 * file really holds.  A manifest that counted the folder instead would point
 * at frames that are not in the file, and the player would ask the decoder
 * for a frame that does not exist.
 *
 * Usage:
 *   node --experimental-strip-types scripts/avatar-build.ts <frames-dir> \
 *     --manifest <avatar.json> --out <output.webp> [--gif <output.gif>] \
 *     [--proof <sheet.png>] [--no-embed]
 *
 *   node --experimental-strip-types scripts/avatar-build.ts --inspect <file.webp>
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import {
  embedAvatarManifest,
  extractAvatarManifest,
  parseAvatarManifest,
  type AvatarManifest,
  type AvatarRange,
  type AvatarState,
} from "../shared/avatar-manifest.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".webp", ".jpg", ".jpeg"]);

export interface FrameSize {
  width: number;
  height: number;
}

/** The dimensions of a PNG, read from its IHDR chunk. */
export function readPngSize(path: string): FrameSize {
  const handle = readFileSync(path);
  if (handle.length < 24 || handle.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${basename(path)}: not a PNG`);
  }
  if (handle.subarray(12, 16).toString("latin1") !== "IHDR") {
    throw new Error(`${basename(path)}: no IHDR chunk`);
  }
  return { width: handle.readUInt32BE(16), height: handle.readUInt32BE(20) };
}

/** Every image in the folder, in name order. */
export function collectFrameFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * The animation's real frame structure, read out of the file itself.
 */
export interface EncodedFrames {
  /** How many frames the file holds. */
  frameCount: number;
  /** Each frame's duration in milliseconds. */
  durations: number[];
}

/**
 * Read the frame count and the per-frame durations out of an animated WebP.
 *
 * The file is the truth about itself.  Every animated frame is one `ANMF`
 * chunk and the chunk carries the frame's duration, so walking the chunks
 * says exactly how many frames a player will find and how long each one
 * lasts.  Nothing here has to guess, which is the point: the manifest that
 * goes inside the file has to describe the file, not the folder it came from.
 */
export function readEncodedFrames(bytes: Buffer): EncodedFrames {
  if (bytes.length < 12 || bytes.subarray(0, 4).toString("latin1") !== "RIFF") {
    throw new Error("not a RIFF file");
  }
  const durations: number[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString("latin1");
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "ANMF") {
      // The frame header is three bytes each for x, y, width and height, then
      // three bytes of duration, then a flags byte.  The animation frame
      // header is little-endian, unlike the rest of RIFF.
      const payload = offset + 8;
      if (payload + 15 > bytes.length) {
        throw new Error("truncated animated frame chunk");
      }
      durations.push(bytes.readUIntLE(payload + 12, 3));
    }
    offset += 8 + size + (size % 2);
  }
  if (durations.length === 0) {
    throw new Error("the file holds no animated frames");
  }
  return { frameCount: durations.length, durations };
}

/**
 * Where every source frame ended up in the encoded file.
 */
export interface FrameMapping {
  /** Source frame index to encoded frame index. */
  map: number[];
  /** How many frames the encoded file holds. */
  encodedCount: number;
  /**
   * The source frames the encoder folded into the frame before them.
   *
   * A frame that looks exactly like the one before it is stored once, with a
   * longer duration, because two identical pictures are one picture held for
   * twice as long.  That is right for the file and wrong for frame numbers:
   * every source frame after a fold moves down by one.  A hold loop where the
   * author holds one pose for twenty frames folds nineteen times, so this is
   * ordinary and not a mistake in the art.
   */
  folded: number[];
}

/**
 * Map every source frame onto the frame the encoded file holds.
 *
 * The durations say exactly where the folds are, so the map is read out of
 * the file rather than predicted from the source.  A prediction would be a
 * guess about the encoder's behaviour, and a guess that is wrong produces a
 * manifest that points at frames which are not there.
 */
export function mapSourceFramesToEncoded(
  durations: number[],
  delayMs: number,
  sourceCount: number,
): FrameMapping {
  const map: number[] = [];
  const folded: number[] = [];
  for (let encoded = 0; encoded < durations.length; encoded++) {
    const duration = durations[encoded];
    if (duration <= 0 || duration % delayMs !== 0) {
      throw new Error(
        `frame ${encoded} lasts ${duration} ms, which is not a whole number of ${delayMs} ms frames; ` +
          "the encoder changed the timing in a way this tool cannot map onto the source frames",
      );
    }
    const absorbed = duration / delayMs;
    for (let i = 0; i < absorbed; i++) {
      if (map.length > 0 && map[map.length - 1] === encoded) {
        folded.push(map.length);
      }
      map.push(encoded);
    }
  }
  if (map.length !== sourceCount) {
    throw new Error(
      `the encoded file holds ${durations.length} frames covering ${map.length} source frames, ` +
        `but the folder holds ${sourceCount}; the encoder dropped or added frames, and the manifest ` +
        "cannot be mapped onto it",
    );
  }
  return { map, encodedCount: durations.length, folded };
}

/**
 * Rewrite a manifest from the author's frame numbers into the file's.
 *
 * A range that spans a fold keeps its meaning: the folded frames hold the
 * same picture as the frame before them, so the range still shows the same
 * art, and it still ends on the same picture.
 */
export function translateManifestToEncoded(manifest: AvatarManifest, mapping: FrameMapping): AvatarManifest {
  const translateRange = (range: AvatarRange): AvatarRange => ({
    from: mapping.map[range.from] ?? range.from,
    to: mapping.map[range.to] ?? range.to,
  });
  const states: AvatarManifest["states"] = {};
  for (const [state, entry] of Object.entries(manifest.states)) {
    const translated: AvatarState = {};
    if (entry.enter) translated.enter = translateRange(entry.enter);
    if (entry.hold) translated.hold = translateRange(entry.hold);
    if (entry.return) translated.return = translateRange(entry.return);
    states[state] = translated;
  }
  return {
    ...manifest,
    frame: { ...manifest.frame, count: mapping.encodedCount },
    restingFrame: mapping.map[manifest.restingFrame] ?? manifest.restingFrame,
    states,
  };
}

/**
 * Everything wrong with a manifest for the frames it will be played with.
 *
 * The list is empty when the manifest is usable.  Each entry is a sentence
 * the author can act on, because a build tool that says "invalid" and stops
 * is a build tool people stop using.
 */
export function validateManifestAgainstFrames(
  manifest: AvatarManifest,
  frameCount: number,
  frameSize: FrameSize | null,
): string[] {
  const problems: string[] = [];

  if (manifest.frame.count !== frameCount) {
    problems.push(
      `the manifest says ${manifest.frame.count} frames but the folder holds ${frameCount}; ` +
        `every frame must be accounted for, because the manifest is what maps frame ranges to animations`,
    );
  }

  const last = frameCount - 1;
  const checkRange = (where: string, range: AvatarRange) => {
    if (range.from > range.to) {
      problems.push(`${where}: from ${range.from} is past to ${range.to}`);
    }
    if (range.to > last) {
      problems.push(
        `${where}: frames ${range.from}-${range.to} run past the last frame; ` +
          `a file with ${frameCount} frames has frames 0-${last}`,
      );
    }
  };
  for (const [state, entry] of Object.entries(manifest.states)) {
    if (entry.enter) checkRange(`state "${state}" enter`, entry.enter);
    if (entry.hold) checkRange(`state "${state}" hold`, entry.hold);
    if (entry.return) checkRange(`state "${state}" return`, entry.return);
  }
  if (manifest.restingFrame > last) {
    problems.push(`restingFrame ${manifest.restingFrame} is past the last frame ${last}`);
  }

  if (frameSize) {
    if (frameSize.width !== manifest.frame.width || frameSize.height !== manifest.frame.height) {
      problems.push(
        `the source frames are ${frameSize.width}x${frameSize.height} but the manifest declares ` +
          `${manifest.frame.width}x${manifest.frame.height}; the frames are scaled to the manifest's size, ` +
          `so declare the size you want the avatar to be`,
      );
    }
  }

  return problems;
}

function run(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Link the source frames into a temp folder under one numbering pattern.
 *
 * `ffmpeg` and `img2webp` both want a predictable sequence, and the author
 * should not have to name their files `frame_0001.png` to use the tool.
 */
function stageFrames(frames: string[], dir: string): string {
  const width = String(frames.length).length;
  frames.forEach((frame, index) => {
    const name = `${String(index + 1).padStart(width, "0")}.png`;
    symlinkSync(resolve(frame), join(dir, name));
  });
  return join(dir, `%0${width}d.png`);
}

export interface BuildOptions {
  framesDir: string;
  manifestPath: string;
  out: string;
  gif?: string;
  proof?: string;
  /** Encode lossy instead of lossless, for a smaller file. */
  lossy?: boolean;
  embed?: boolean;
}

export interface BuildResult {
  /** The manifest as it went into the file. */
  manifest: AvatarManifest;
  /** How many frames the source folder held. */
  sourceFrameCount: number;
  /** How many frames the encoded file holds. */
  encodedFrameCount: number;
  /** The source frames the encoder folded together. */
  folded: number[];
  sourceSize: FrameSize;
  outputSize: FrameSize;
  bytes: number;
}

/** The whole build, from a folder of frames to an embedded-manifest WebP. */
export function buildAvatar(options: BuildOptions): BuildResult {
  const frames = collectFrameFiles(options.framesDir);
  if (frames.length === 0) {
    throw new Error(`no images in ${options.framesDir}`);
  }

  const manifest = parseAvatarManifest(readFileSync(options.manifestPath, "utf8"));
  if (!manifest) {
    throw new Error(`${options.manifestPath}: not a valid avatar manifest`);
  }

  const sourceSize = readPngSize(frames[0]);
  for (const frame of frames.slice(1)) {
    const size = readPngSize(frame);
    if (size.width !== sourceSize.width || size.height !== sourceSize.height) {
      throw new Error(
        `${basename(frame)} is ${size.width}x${size.height} but the first frame is ` +
          `${sourceSize.width}x${sourceSize.height}; every frame must be the same size`,
      );
    }
  }

  const problems = validateManifestAgainstFrames(manifest, frames.length, {
    width: manifest.frame.width,
    height: manifest.frame.height,
  });
  if (problems.length > 0) {
    throw new Error(`the manifest does not fit the frames:\n  - ${problems.join("\n  - ")}`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "avatar-build-"));
  try {
    const staged = stageFrames(frames, scratch);
    const scaled = join(scratch, "scaled");
    mkdirSync(scaled);

    // Scale to the declared size.  The source art is usually far larger than
    // the avatar ever renders, and carrying that cost is what made the old
    // packs weigh hundreds of megabytes.
    const scaledPattern = join(scaled, "%0" + String(frames.length).length + "d.png");
    run("ffmpeg", [
      "-y",
      "-framerate", "1",
      "-i", staged,
      "-vf", `scale=${manifest.frame.width}:${manifest.frame.height}:flags=lanczos`,
      "-pix_fmt", "rgba",
      scaledPattern,
    ]);

    const scaledFrames = readdirSync(scaled).sort();
    const webpPattern = join(scaled, "%0" + String(frames.length).length + "d.png");
    // The encoder settings are a deliberate balance, not a default nobody
    // looked at:
    //
    // - `-m 4` instead of `-m 6` is eleven times faster on a 36 frame file and
    //   the same size to within a kilobyte.  A build an artist waits on is a
    //   build they get wrong.
    // - `-exact` keeps the colour of fully transparent pixels, which matters
    //   because an avatar is composited over the interface: without it the
    //   edges of a lossy encode pick up the colour of what is behind them.
    // - `-lossy` is opt-in.  Lossless is the default because it is what the
    //   author drew; `--lossy` is there for a file that has to be small.
    const encoder = options.lossy
      ? ["-lossy", "-q", "90", "-m", "4", "-exact"]
      : ["-lossless", "-m", "4", "-exact"];
    run("img2webp", [
      "-loop", "0",
      "-d", String(manifest.frame.delayMs),
      ...encoder,
      ...scaledFrames.map((name) => join(scaled, name)),
      "-o", options.out,
    ]);

    let bytes = readFileSync(options.out);

    // The file is written before the manifest goes into it, because the file
    // is what says how many frames there really are.  An encoder stores a
    // frame that looks exactly like the one before it once, with a longer
    // duration, so the encoded file can hold fewer frames than the folder
    // did.  A manifest that counted the folder's frames would then point at
    // frames that are not in the file, and the player would ask the decoder
    // for a frame that does not exist.
    let encoded: EncodedFrames;
    try {
      encoded = readEncodedFrames(bytes);
    } catch (error) {
      if (String(error).includes("no animated frames")) {
        throw new Error(
          "the encoder produced a still image, not an animation: every frame in the folder " +
            "looks the same. An animated avatar needs at least two different frames.",
        );
      }
      throw error;
    }
    const mapping = mapSourceFramesToEncoded(encoded.durations, manifest.frame.delayMs, frames.length);
    const fileManifest = translateManifestToEncoded(manifest, mapping);

    if (options.embed !== false) {
      try {
        bytes = embedAvatarManifest(bytes, fileManifest);
      } catch (error) {
        // The manifest can only ride in an extended WebP, and an animated
        // WebP always is one.  Reaching this means the file is not an
        // animation after all, and the underlying complaint is about the WebP
        // format and not about the art, and the art is the thing the author
        // can fix.
        if (String(error).includes("extended WebP")) {
          throw new Error(
            "the encoder produced a still image, not an animation: every frame in the folder " +
              "looks the same. An animated avatar needs at least two different frames.",
          );
        }
        throw error;
      }
      writeFileSync(options.out, bytes);
    }

    if (options.gif) {
      // A GIF cannot carry the manifest, so it is the compatibility copy:
      // the file loops as a whole and plays in anything that takes a GIF.
      // The frame rate goes on the INPUT, not through an fps filter: the
      // filter resamples against the input's own timeline and drops frames
      // when the source was read at a different rate.
      run("ffmpeg", [
        "-y",
        "-framerate", String(Math.round(1000 / manifest.frame.delayMs)),
        "-i", webpPattern,
        "-vf", "split[s0][s1];[s0]palettegen=max_colors=255[p];[s1][p]paletteuse",
        "-loop", "0",
        options.gif,
      ]);
    }

    if (options.proof) {
      // One sheet of every frame, so the author can see the whole animation
      // at once instead of scrubbing a folder.
      run("ffmpeg", [
        "-y",
        "-framerate", "1",
        "-i", webpPattern,
        "-vf", "scale=160:160:flags=lanczos,tile=8x8:padding=4:margin=4:color=white",
        "-frames:v", "1",
        options.proof,
      ]);
    }

    return {
      manifest: fileManifest,
      sourceFrameCount: frames.length,
      encodedFrameCount: mapping.encodedCount,
      folded: mapping.folded,
      sourceSize,
      outputSize: { width: manifest.frame.width, height: manifest.frame.height },
      bytes: bytes.length,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Print what a built avatar contains, for checking a handoff. */
export function inspectAvatar(path: string): string {
  const bytes = readFileSync(path);
  const manifest = extractAvatarManifest(bytes);
  if (!manifest) {
    return [
      `${basename(path)}: no embedded manifest.`,
      "It plays as an ordinary looping image. Run the build with --embed to add one.",
    ].join("\n");
  }

  // The frame count in the manifest and the frame count in the file have to
  // agree.  When they do not, the player asks the decoder for frames that are
  // not there, so this check is worth saying out loud rather than burying.
  let realCount: number | null = null;
  try {
    realCount = readEncodedFrames(bytes).frameCount;
  } catch {
    realCount = null;
  }

  const lines = [
    `${basename(path)}: ${manifest.name} (format ${manifest.formatVersion})`,
    `  frames: ${manifest.frame.count} at ${manifest.frame.width}x${manifest.frame.height}, ${manifest.frame.delayMs} ms each`,
  ];
  if (realCount === null) {
    lines.push("  the file holds no animated frames, so this is a still image");
  } else if (realCount !== manifest.frame.count) {
    lines.push(
      `  WARNING: the manifest says ${manifest.frame.count} frames but the file holds ${realCount}; ` +
        "the ranges point at frames that are not there",
    );
  } else {
    lines.push(`  the file holds ${realCount} frames, which matches the manifest`);
  }
  lines.push(`  resting frame: ${manifest.restingFrame}`);
  lines.push(`  states:`);
  for (const [state, entry] of Object.entries(manifest.states)) {
    const describe = (range: AvatarRange | undefined) =>
      range ? `${range.from}-${range.to}` : "-";
    lines.push(
      `    ${state}: enter ${describe(entry.enter)}  hold ${describe(entry.hold)}  return ${describe(entry.return)}`,
    );
  }
  return lines.join("\n");
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  if (args[0] === "--inspect") {
    if (!args[1] || !existsSync(args[1])) {
      console.error("usage: avatar-build.ts --inspect <file.webp>");
      return 2;
    }
    console.log(inspectAvatar(args[1]));
    return 0;
  }

  const framesDir = args[0];
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const manifestPath = flag("--manifest");
  const out = flag("--out");
  if (!framesDir || !manifestPath || !out) {
    console.error(
      "usage: avatar-build.ts <frames-dir> --manifest <avatar.json> --out <output.webp> " +
        "[--gif <output.gif>] [--proof <sheet.png>] [--lossy] [--no-embed]",
    );
    return 2;
  }
  if (!existsSync(framesDir)) {
    console.error(`${framesDir}: no such folder`);
    return 2;
  }

  try {
    const result = buildAvatar({
      framesDir,
      manifestPath,
      out,
      gif: flag("--gif"),
      proof: flag("--proof"),
      lossy: args.includes("--lossy"),
      embed: !args.includes("--no-embed"),
    });
    console.log(`built ${out}`);
    console.log(
      `  ${result.sourceFrameCount} frames, ${result.sourceSize.width}x${result.sourceSize.height} source, ` +
        `${result.outputSize.width}x${result.outputSize.height} out, ${(result.bytes / 1024).toFixed(0)} KB`,
    );
    if (result.folded.length > 0) {
      console.log(
        `  ${result.folded.length} identical frame(s) were stored once with a longer duration, so the file ` +
          `holds ${result.encodedFrameCount} frames; the manifest's ranges were mapped onto them`,
      );
      console.log(`  folded source frames: ${result.folded.join(", ")}`);
    } else {
      console.log(`  the file holds ${result.encodedFrameCount} frames`);
    }
    console.log(`  embedded manifest: ${result.manifest.name}`);
    return 0;
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  process.exit(main(process.argv));
}
