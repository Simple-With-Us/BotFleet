import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConversationThreadTabs } from "./ThreadTabs";

const tasks = [
  { threadId: "thread-a", title: "Active Work", createdAt: 1 },
  { threadId: "thread-b", title: "Retained History", createdAt: 2 },
];

function render(props: Partial<Parameters<typeof ConversationThreadTabs>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ConversationThreadTabs, {
      threadId: "thread-a",
      tasks,
      busy: true,
      onSwitch: () => {},
      onRename: () => {},
      onDelete: () => {},
      ...props,
    }),
  );
}

describe("thread tabs while the bot works", () => {
  it("leaves a non-active tab clickable for viewing while busy", () => {
    const html = render({ viewedThreadId: null, onView: () => {} });
    // The retained tab itself carries no disabled attribute (the close
    // button on the active tab still does); picking it views, never
    // switches (the intent decision is covered in TaskPicker.test.ts).
    expect(html).toContain('aria-selected="false" title="Retained History');
    expect(html).not.toContain("opacity-40");
  });

  it("keeps the old busy gate when no viewing affordance is offered", () => {
    const html = render();
    expect(html).toContain('aria-selected="false" disabled="" title="Retained History');
    expect(html).toContain("opacity-40");
  });

  it("marks the viewed tab as viewing, distinct from the active tab", () => {
    const html = render({ viewedThreadId: "thread-b", onView: () => {} });
    expect(html).toContain('data-active-thread="true"');
    expect(html).toContain('data-viewed-thread="true"');
    expect(html).toContain("Viewing");
    // both the execution target and the browsed thread are selected tabs,
    // but only the active one carries the strong accent border class pair
    expect(html.match(/aria-selected="true"/g)).toHaveLength(2);
  });
});
