import { describe, expect, it } from "vitest";

import {
  ITEM_IO_CAPTURE_LIMIT,
  ITEM_IO_FIELD_LIMIT,
  boundText,
  captureBoth,
  captureInput,
  captureOutput,
  cutText,
  inputText,
  outputText,
  prepareInput,
  textSignature,
} from "./item-io.ts";
import { redactSecretsForLog } from "./redact.ts";

describe("bounding text", () => {
  it("leaves text within the limit alone and reports its length", () => {
    expect(boundText("hello", 10)).toEqual({ text: "hello", truncated: false, length: 5 });
  });

  it("cuts to the limit, says so, and remembers the original length", () => {
    expect(boundText("abcdefghij", 4)).toEqual({ text: "abcd", truncated: true, length: 10 });
  });

  it("never ends on the first half of a surrogate pair", () => {
    // "😀" is two UTF-16 units; a cut between them would render a replacement glyph
    const cut = cutText("ab😀cd", 3);
    expect(cut).toBe("ab");
    expect(boundText("ab😀cd", 3).text).toBe("ab");
  });

  it("captures a little past the stored field limit so redaction can still fill it", () => {
    expect(ITEM_IO_CAPTURE_LIMIT).toBeGreaterThan(ITEM_IO_FIELD_LIMIT);
  });
});

describe("inputText", () => {
  it("re-indents OpenAI-shaped JSON arguments", () => {
    expect(inputText('{"path":"a.ts","n":2}')).toBe('{\n  "path": "a.ts",\n  "n": 2\n}');
  });

  it("keeps a partial JSON fragment verbatim instead of dropping it", () => {
    expect(inputText('{"path":"a.ts","con')).toBe('{"path":"a.ts","con');
  });

  it("keeps a plain string as it is", () => {
    expect(inputText("echo hi")).toBe("echo hi");
  });

  it("pretty-prints an object", () => {
    expect(inputText({ command: "ls" })).toBe('{\n  "command": "ls"\n}');
  });

  it("says nothing for an empty, absent or argument-less input", () => {
    for (const value of [undefined, null, "", "   ", {}, [], "{}", "[]"]) expect(inputText(value)).toBeUndefined();
  });

  it("survives a cycle", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(typeof inputText(loop)).toBe("string");
  });

  it("does not parse a multi-megabyte argument string on the event path", () => {
    const huge = `{"content":"${"x".repeat(ITEM_IO_CAPTURE_LIMIT * 5)}"}`;
    // verbatim: a re-indent would have added newlines
    expect(inputText(huge)).toBe(huge);
  });
});

describe("input redaction and bounds", () => {
  const ENV_VALUE = "abcd1234efgh5678";

  it("masks a {name, value} env entry by its name before flattening the input to text", () => {
    const input = { env: [{ name: "OMB_COMMS_TOKEN", value: ENV_VALUE }] };
    // the text pass alone cannot see this: after flattening it is two ordinary strings
    expect(inputText(input)).not.toContain(ENV_VALUE);
    expect(inputText(input)).toContain("redacted 16 chars");
    // and it agrees with what the event log's tee does with the same object
    expect(JSON.stringify(redactSecretsForLog(input))).not.toContain(ENV_VALUE);
  });

  it("masks the same entry inside OpenAI-shaped JSON arguments", () => {
    const text = inputText(JSON.stringify({ env: [{ name: "OMB_COMMS_TOKEN", value: ENV_VALUE }], cmd: "ls" }));
    expect(text).not.toContain(ENV_VALUE);
    expect(text).toContain('"cmd": "ls"');
  });

  it("masks a secret-shaped key and a credential inside an ordinary string", () => {
    const token = `sk-proj-${"c".repeat(24)}`;
    const text = inputText({ api_key: "plain-looking-value", command: `curl -H "Authorization: Bearer ${token}"` });
    expect(text).not.toContain("plain-looking-value");
    expect(text).not.toContain("c".repeat(24));
  });

  it("cuts a long string leaf before redacting or serializing it, and still reports the original size", () => {
    const body = "w".repeat(ITEM_IO_CAPTURE_LIMIT * 40);
    const prepared = prepareInput({ path: "big.txt", content: body });
    expect(prepared).toBeDefined();
    // the work was bounded: the text is a little over the limit, not 40 times it
    expect(prepared!.text.length).toBeLessThan(ITEM_IO_CAPTURE_LIMIT + 200);
    expect(prepared!.elided).toBe(body.length - ITEM_IO_CAPTURE_LIMIT);
    const capture = captureInput({ path: "big.txt", content: body });
    expect(capture.io?.input?.truncated).toBe(true);
    expect(capture.io?.input?.length).toBeGreaterThanOrEqual(body.length);
    expect(capture.io?.input?.text).toContain("big.txt");
  });

  it("says a capture was truncated when only a leaf was cut and the text still fits", () => {
    const capture = captureInput({ content: "q".repeat(ITEM_IO_CAPTURE_LIMIT + 1) });
    expect(capture.io?.input?.truncated).toBe(true);
  });

  it("fingerprints a text by length and both ends", () => {
    const text = `${"a".repeat(100)}${"b".repeat(100)}`;
    expect(textSignature(text)).toBe(textSignature(`${text}`));
    expect(textSignature(text)).not.toBe(textSignature(`${text}c`));
    expect(textSignature("")).toBe("0::");
    // short enough to hold per open call
    expect(textSignature("z".repeat(1_000_000)).length).toBeLessThan(120);
  });
});

describe("outputText", () => {
  it("returns a string result as it is", () => {
    expect(outputText("ok")).toBe("ok");
  });

  it("joins Claude tool_result text blocks", () => {
    expect(outputText([{ type: "text", text: "one" }, { type: "text", text: "two" }])).toBe("one\ntwo");
  });

  it("unwraps ACP content blocks", () => {
    expect(outputText([{ type: "content", content: { type: "text", text: "from acp" } }])).toBe("from acp");
  });

  it("marks an image rather than dropping the step's whole result", () => {
    expect(outputText([{ type: "text", text: "saw" }, { type: "image", source: "x" }])).toBe("saw\n[image]");
  });

  it("shows a diff block's file and new text", () => {
    expect(outputText([{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }])).toBe("a.ts\nb");
  });

  it("reads Codex-style output fields", () => {
    expect(outputText({ aggregatedOutput: undefined, output: "built" })).toBe("built");
    expect(outputText({ stdout: "out" })).toBe("out");
  });

  it("falls back to the JSON of a shape with no text in it", () => {
    expect(outputText({ rows: 3 })).toBe('{\n  "rows": 3\n}');
  });

  it("says nothing for an absent or empty result", () => {
    for (const value of [undefined, null, "", [], {}]) expect(outputText(value)).toBeUndefined();
  });
});

describe("capture helpers", () => {
  it("wrap input and output into the shape an event carries", () => {
    expect(captureInput({ a: 1 })).toEqual({
      io: { input: { text: '{\n  "a": 1\n}', truncated: false, length: 12 } },
    });
    expect(captureOutput("done")).toEqual({ io: { output: { text: "done", truncated: false, length: 4 } } });
  });

  it("add nothing when there is nothing to record", () => {
    expect(captureInput(undefined)).toEqual({});
    expect(captureOutput(undefined)).toEqual({});
    expect(captureBoth(undefined, undefined)).toEqual({});
  });

  it("bound an oversized result and keep its real length", () => {
    const capture = captureOutput("y".repeat(ITEM_IO_CAPTURE_LIMIT + 500));
    expect(capture.io?.output?.truncated).toBe(true);
    expect(capture.io?.output?.text.length).toBe(ITEM_IO_CAPTURE_LIMIT);
    expect(capture.io?.output?.length).toBe(ITEM_IO_CAPTURE_LIMIT + 500);
  });

  it("captureBoth keeps whichever halves exist", () => {
    expect(captureBoth("x", undefined).io).toEqual({ input: { text: "x", truncated: false, length: 1 } });
    expect(captureBoth(undefined, "y").io).toEqual({ output: { text: "y", truncated: false, length: 1 } });
    expect(Object.keys(captureBoth("x", "y").io ?? {})).toEqual(["input", "output"]);
  });
});
