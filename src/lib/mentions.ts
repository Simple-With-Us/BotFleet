// Mention and tag definitions, regex, and markdown plugin for @ (Bots) and # (Apps/Channels).

import { POPULAR_APPS } from "./apps-catalog";

const MULTI_WORD_APPS = POPULAR_APPS
  .map((a) => a.name)
  .filter((name) => name.includes(" "))
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

export const MENTION_REGEX = new RegExp(
  `(?:^|(?<=[\\s(\\["'“‘]))([@#](?:${MULTI_WORD_APPS}|"[^"\\n]+"|'[^'\\n]+'|[“‘][^”’\\n]+[”’]|\\[[^\\]\\n]+\\]|[a-zA-Z0-9_\\-\\.]+))(?=$|[\\s)\\]"'”’.,:;!?])`,
  "g"
);

export const MENTION_TOKEN_REGEX = new RegExp(
  `^[@#](?:${MULTI_WORD_APPS}|"[^"\\n]+"|'[^'\\n]+'|[“‘][^”’\\n]+[”’]|\\[[^\\]\\n]+\\]|[a-zA-Z0-9_\\-\\.]+)$`
);

export function isMentionToken(token: string): boolean {
  return MENTION_TOKEN_REGEX.test(token);
}

export const MENTION_CLASS = "font-bold text-[1.05em] text-accent inline-block align-baseline";

/**
 * Remark plugin that transforms @bot and #channel/#app tokens in markdown
 * text nodes into styled bolder and slightly larger mention spans.
 * Leaves code blocks, inline code, and links unmodified.
 */
export function remarkMentions() {
  return (tree: any) => {
    function visit(node: any) {
      if (!node || !node.children) return;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.type === "text" && Object.prototype.toString.call(child.value) === "[object String]") {
          const parts = child.value.split(MENTION_REGEX);
          if (parts.length > 1) {
            const newChildren = parts
              .map((part: string) => {
                if (isMentionToken(part)) {
                  return {
                    type: "textDirective",
                    data: {
                      hName: "span",
                      hProperties: {
                        className: MENTION_CLASS,
                      },
                    },
                    children: [{ type: "text", value: part }],
                  };
                }
                return { type: "text", value: part };
              })
              .filter((p: { type: string; value?: string }) => p.value !== "");
            node.children.splice(i, 1, ...newChildren);
            i += newChildren.length - 1;
          }
        } else if (child.type !== "code" && child.type !== "inlineCode") {
          visit(child);
        }
      }
    }
    visit(tree);
  };
}
