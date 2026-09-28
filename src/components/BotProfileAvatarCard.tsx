import { useRef, useState, type DragEvent } from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";

import { type Bot } from "@/state/store";
import { guessImageMime, imageAttachmentFromFile } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { productErrorHeadline } from "@/lib/product-error";
import {
  PICKABLE_STATES,
  BOT_COLORS,
  BOT_COLOR_NAMES,
  type BotMotion,
  type BotState,
} from "@/lib/mascot";
import {
  avatarCropAfterUpload,
  BOT_AVATAR_CROPS,
  botAvatarUrlFromStoredPath,
  type BotAvatarCrop,
} from "../../shared/bot-avatar";
import { BotAvatar, BotMascot } from "./Avatar";
import { TVFaceAvatar } from "./tv-face/TVFaceAvatar";

type AvatarPatch = Partial<
  Pick<Bot, "avatarCrop" | "avatarUrl" | "color" | "mascotExpression">
>;

const CROP_LABEL = {
  mascot: "Mascot",
  tvface: "TV-Face",
  circle: "Circle",
  rounded: "Rounded",
  square: "Square",
} satisfies Record<BotAvatarCrop, string>;

export function BotProfileAvatarCard({
  bot,
  activeState,
  mascotMotion,
  onPatch,
}: {
  bot: Bot;
  activeState: BotState;
  mascotMotion: { kind: Exclude<BotMotion, "none">; nonce: number } | null;
  onPatch: (patch: AvatarPatch) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const crop = bot.avatarCrop ?? "mascot";
  const cropRef = useRef(crop);
  cropRef.current = crop;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const mime = guessImageMime(file);
      const saved = await imageAttachmentFromFile({
        name: file.name,
        size: file.size,
        type: mime ?? file.type,
        arrayBuffer: () => file.arrayBuffer(),
      });
      if (!saved) throw new Error("Drop a PNG, JPEG, GIF, WebP, HEIC, BMP, or SVG image");
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw new Error("The uploaded image could not be used as an avatar");
      const latestCrop = cropRef.current;
      onPatch({ avatarUrl, avatarCrop: avatarCropAfterUpload(latestCrop) });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeImage = () => {
    setError(null);
    onPatch({ avatarUrl: null, avatarCrop: "mascot" });
  };
  return (
    <div className="overflow-hidden rounded-xl border border-hairline/40 bg-card">
      <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2.5">
        <span className="rounded-lg bg-control px-3 py-1.5 text-[14px] font-medium text-ink">Avatar</span>
        <button
          onClick={() => onPatch({ avatarCrop: "mascot", color: "green", mascotExpression: null })}
          className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
        >
          Reset mascot
        </button>
      </div>

      <div className="p-3">
        <div
          role="button"
          tabIndex={0}
          aria-label="Bot avatar. Drop an image here to change it."
          className={cn(
            "flex justify-center rounded-xl py-3 transition-colors",
            dragOver ? "bg-accent/10 ring-2 ring-accent-border" : "bg-transparent",
          )}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              fileRef.current?.click();
            }
          }}
          onDragEnter={(event: DragEvent) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(event: DragEvent) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }}
          onDragLeave={(event: DragEvent) => {
            if (event.currentTarget.contains(event.relatedTarget as Node)) return;
            setDragOver(false);
          }}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            setDragOver(false);
            const file = event.dataTransfer.files.item(0) ?? undefined;
            void upload(file);
          }}
        >
          <BotAvatar
            bot={bot}
            state={activeState}
            size={112}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
        </div>

        <div className="mt-2 flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif,image/avif,image/bmp,image/svg+xml,.heic,.heif,.bmp,.svg,.gif"
            className="sr-only"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            Upload image
          </button>
          {bot.avatarUrl && (
            <button
              type="button"
              onClick={removeImage}
              disabled={uploading}
              aria-label="Remove Custom Avatar Image"
              title="Remove Custom Image"
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div className="mt-1.5 text-[11.5px] text-ink-secondary">Drop an image onto the avatar.  PNG, JPEG, GIF, WebP, HEIC, BMP, or SVG · up to 10 MB</div>

        <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
          Shape
        </div>
        <div className="grid grid-cols-5 overflow-hidden rounded-lg border border-hairline/40">
          {BOT_AVATAR_CROPS.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={crop === candidate}
              onClick={() => onPatch({ avatarCrop: candidate })}
              className={cn(
                "py-1.5 text-[12.5px]",
                index > 0 && "border-l border-hairline/40",
                crop === candidate ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {CROP_LABEL[candidate]}
            </button>
          ))}
        </div>

        {(crop === "mascot" || crop === "tvface") && (
          <>
            <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Expression
            </div>
            <div className="grid grid-cols-5 gap-2">
              {PICKABLE_STATES.map((expression) => (
                <button
                  key={expression}
                  type="button"
                  aria-pressed={activeState === expression}
                  onClick={() => onPatch({ mascotExpression: expression })}
                  className={cn(
                    "flex h-[58px] items-center justify-center rounded-xl bg-inset transition-colors hover:bg-control",
                    activeState === expression && "ring-2 ring-accent-border",
                  )}
                  title={expression}
                  aria-label={`Use ${expression} expression`}
                >
                  {crop === "tvface" ? (
                    <TVFaceAvatar color={bot.color} state={expression} size={42} animated={false} />
                  ) : (
                    <BotMascot color={bot.color} state={expression} size={42} animated={false} />
                  )}
                </button>
              ))}
            </div>

            <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Color
            </div>
            <div className="flex flex-wrap gap-2.5">
              {BOT_COLOR_NAMES.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-pressed={bot.color === color}
                  onClick={() => onPatch({ color })}
                  className={cn(
                    "size-10 rounded-full border-2 border-transparent transition-transform hover:scale-110",
                    bot.color === color && "ring-2 ring-accent-border ring-offset-2 ring-offset-card",
                  )}
                  style={{ backgroundColor: BOT_COLORS[color] }}
                  title={color}
                  aria-label={`Use ${color} mascot color`}
                />
              ))}
            </div>
          </>
        )}


        {error && <div role="alert" className="mt-3 text-[12px] text-danger" title={error}>{productErrorHeadline(error)}</div>}
      </div>
    </div>
  );
}
