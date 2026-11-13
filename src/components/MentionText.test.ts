import { describe, expect, it } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { MentionText } from "./MentionText";
import { MENTION_CLASS, remarkMentions } from "@/lib/mentions";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

describe("MentionText component", () => {
  it("renders plain text without mentions unchanged", () => {
    const html = ReactDOMServer.renderToStaticMarkup(React.createElement(MentionText, { text: "Hello world!" }));
    expect(html).toBe("Hello world!");
  });

  it("renders @mention and #channel bolder and slightly larger", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MentionText, { text: "Hey @Jarvis, check #general" }),
    );
    expect(html).toContain(`<span class="${MENTION_CLASS}">@Jarvis</span>`);
    expect(html).toContain(`<span class="${MENTION_CLASS}">#general</span>`);
  });

  it("does not style emails or URL anchors", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MentionText, { text: "Email test@example.com or visit http://site#part" }),
    );
    expect(html).not.toContain(`<span class="${MENTION_CLASS}">`);
  });

  it("renders multi-word app mentions with spaces as a single entity", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MentionText, { text: "Open #Google Sheets and check #Google Calendar" }),
    );
    expect(html).toContain(`<span class="${MENTION_CLASS}">#Google Sheets</span>`);
    expect(html).toContain(`<span class="${MENTION_CLASS}">#Google Calendar</span>`);
  });

  it("renders quoted multi-word mentions", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(MentionText, { text: 'Ask @"Custom Bot" in #"Private Room"' }),
    );
    expect(html).toContain(`<span class="${MENTION_CLASS}">@&quot;Custom Bot&quot;</span>`);
    expect(html).toContain(`<span class="${MENTION_CLASS}">#&quot;Private Room&quot;</span>`);
  });
});

describe("remarkMentions plugin with Markdown", () => {
  it("styles mentions in markdown paragraphs", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Markdown, { remarkPlugins: [remarkGfm, remarkMentions] }, "Please ask @Scout in #slack"),
    );
    expect(html).toContain(`<span class="${MENTION_CLASS}">@Scout</span>`);
    expect(html).toContain(`<span class="${MENTION_CLASS}">#slack</span>`);
  });

  it("preserves code blocks without styling mentions", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      React.createElement(Markdown, { remarkPlugins: [remarkGfm, remarkMentions] }, "```\n@insideCode #notAMention\n```"),
    );
    expect(html).not.toContain(`<span class="${MENTION_CLASS}">`);
    expect(html).toContain("@insideCode #notAMention");
  });
});
