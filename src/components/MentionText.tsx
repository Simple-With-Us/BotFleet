import { Fragment } from "react";
import { MENTION_CLASS, MENTION_REGEX, isMentionToken } from "@/lib/mentions";

/**
 * Renders plain text with @bot and #app/#channel mentions styled bolder and slightly larger.
 */
export function MentionText({ text }: { text: string }) {
  if (!text) return null;

  const parts = text.split(MENTION_REGEX);
  if (parts.length === 1) {
    return <>{text}</>;
  }

  return (
    <>
      {parts.map((part, i) => {
        if (isMentionToken(part)) {
          return (
            <span key={i} className={MENTION_CLASS}>
              {part}
            </span>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
