// The pronunciation list: what it rewrites, what it must never touch, and
// the one validator every client and the harness share.
import { describe, expect, it } from "vitest";

import {
  applyPronunciations,
  checkPronunciations,
  DEFAULT_PRONUNCIATIONS,
  effectivePronunciations,
  findPronunciations,
  PRONUNCIATION_SAY_MAX,
  PRONUNCIATION_TERM_MAX,
  PRONUNCIATIONS_MAX,
  pronouncer,
  PronunciationDraftListSchema,
  pronunciationsFingerprint,
  sanitizeStoredPronunciations,
  type Pronunciation,
} from "./pronunciations.ts";
import { pronounceUtterance, sourceOffsetAt, utterancesWithSpans } from "./speech-spans.ts";

const say = (text: string, list: readonly Pronunciation[] = DEFAULT_PRONUNCIATIONS) => applyPronunciations(text, list);

describe("DEFAULT_PRONUNCIATIONS", () => {
  it("seeds the owner's list, said as words", () => {
    expect(DEFAULT_PRONUNCIATIONS.map((p) => [p.term, p.say])).toEqual([
      ["JSON", "Jason"],
      ["SaaS", "sass"],
      ["SQL", "sequel"],
      ["REGEX", "redge ex"],
      ["GUI", "gooey"],
      ["CAPTCHA", "cap cha"],
      ["sudo", "soo doo"],
      ["cron", "kron"],
      ["OAuth", "oh auth"],
    ]);
  });

  it("passes its own validator, so the seeded list is idempotent", () => {
    const checked = checkPronunciations(DEFAULT_PRONUNCIATIONS);
    expect(checked).toEqual({ ok: true, list: DEFAULT_PRONUNCIATIONS });
    const once = say("Run sudo crontab, then cron, JSON and OAuth.");
    expect(say(once)).toBe(once);
  });

  it("is what a never-saved setting means; a saved list, even empty, is used as is", () => {
    expect(effectivePronunciations(undefined)).toBe(DEFAULT_PRONUNCIATIONS);
    expect(effectivePronunciations(null)).toBe(DEFAULT_PRONUNCIATIONS);
    expect(effectivePronunciations([])).toEqual([]);
    const mine = [{ term: "SQL", say: "S Q L" }];
    expect(effectivePronunciations(mine)).toBe(mine);
  });
});

describe("applyPronunciations", () => {
  it("replaces whole words", () => {
    expect(say("The SQL query returns JSON.")).toBe("The sequel query returns Jason.");
    expect(say("Use OAuth with sudo and a cron job on the GUI.")).toBe("Use oh auth with soo doo and a kron job on the gooey.");
    expect(say("Solve the CAPTCHA, then the REGEX, then the SaaS bill.")).toBe(
      "Solve the cap cha, then the redge ex, then the sass bill.",
    );
  });

  it("matches a term with no capitals in any case", () => {
    expect(say("Sudo first.  Then CRON, then Cron.")).toBe("soo doo first.  Then kron, then kron.");
  });

  it("matches a term with capitals only as written or in all capitals", () => {
    expect(say("SAAS and OAUTH, as written in a heading")).toBe("sass and oh auth, as written in a heading");
    // Lowercase or other spellings are another word, or the owner's to add.
    expect(say("the sql query returns json")).toBe("the sql query returns json");
    expect(say("Saas, Oauth and Json")).toBe("Saas, Oauth and Json");
  });

  it("never rewrites an ordinary word that shares an acronym's letters", () => {
    const list = [
      { term: "A", say: "ay" },
      { term: "IT", say: "eye tee" },
      { term: "AM", say: "ay em" },
      { term: "US", say: "you ess" },
      { term: "OR", say: "oh are" },
    ];
    expect(checkPronunciations(list)).toEqual({ ok: true, list });
    expect(applyPronunciations("I have a dog and it is fine.  IT dept.", list)).toBe(
      "I have a dog and it is fine.  eye tee dept.",
    );
    expect(applyPronunciations("Tell us, am I late or early?  A US flight at 9 AM, OR route.", list)).toBe(
      "Tell us, am I late or early?  ay you ess flight at 9 ay em, oh are route.",
    );
    expect(applyPronunciations("It is.  Am I?  Us too.  Or not.", list)).toBe("It is.  Am I?  Us too.  Or not.");
  });

  it("keeps punctuation around a term", () => {
    expect(say("(SQL)")).toBe("(sequel)");
    expect(say("JSON.")).toBe("Jason.");
    expect(say("\"JSON\", SQL; GUI!")).toBe("\"Jason\", sequel; gooey!");
    expect(say("JSON's keys")).toBe("Jason's keys");
    expect(say("JSON-RPC")).toBe("Jason-RPC");
  });

  it("never touches a term inside another word", () => {
    expect(say("sudoers and crontab")).toBe("sudoers and crontab");
    expect(say("jsonl files and parseJSON")).toBe("jsonl files and parseJSON");
    expect(say("MySQL and SQLite")).toBe("MySQL and SQLite");
    expect(say("my_json_file")).toBe("my_json_file");
    expect(say("JSONL5 and OAuth2Client")).toBe("JSONL5 and OAuth2Client");
  });

  it("reads a version number after a term as its own word", () => {
    expect(say("Set up the OAuth2 flow.")).toBe("Set up the oh auth 2 flow.");
    expect(say("JSON5, SQL2016 and GUI2")).toBe("Jason 5, sequel 2016 and gooey 2");
    // Only after a term ending in a letter, and only when the digits end it.
    expect(say("OAuth2x")).toBe("OAuth2x");
    expect(applyPronunciations("C#5", [{ term: "C#", say: "C sharp" }])).toBe("C sharp 5");
  });

  it("never touches URLs, paths, emails, file names or dotted names", () => {
    expect(say("Open config.json now")).toBe("Open config.json now");
    expect(say("Edit src/SQL/x.ts and src/cron today")).toBe("Edit src/SQL/x.ts and src/cron today");
    expect(say("See https://example.com/JSON for JSON")).toBe("See https://example.com/JSON for Jason");
    expect(say("Mail SQL@example.com")).toBe("Mail SQL@example.com");
    expect(say("C:\\cron\\jobs")).toBe("C:\\cron\\jobs");
    expect(say("JSON.parse returns")).toBe("JSON.parse returns");
    expect(say("JSON.org and SQL.js")).toBe("JSON.org and SQL.js");
    expect(say("Read /cron, ~/cron, ./cron, ../cron, cron/ and jobs/cron now")).toBe(
      "Read /cron, ~/cron, ./cron, ../cron, cron/ and jobs/cron now",
    );
    expect(say("See (/etc/cron.d/job) and jobs/cron/daily")).toBe("See (/etc/cron.d/job) and jobs/cron/daily");
  });

  it("respells terms joined by a single slash, which is prose, not a path", () => {
    expect(say("Use JSON/YAML configs and SQL/NoSQL stores.")).toBe("Use Jason/YAML configs and sequel/NoSQL stores.");
    expect(say("The GUI/CLI split, (OAuth/OIDC) flows, GUI/cli too.")).toBe(
      "The gooey/CLI split, (oh auth/OIDC) flows, gooey/cli too.",
    );
    expect(say("Set up the OAuth2 flow and convert JSON/YAML from SQL/NoSQL.")).toBe(
      "Set up the oh auth 2 flow and convert Jason/YAML from sequel/NoSQL.",
    );
  });

  it("never touches a MiniMax pause tag", () => {
    const list = [{ term: "#", say: "hash" }, { term: "0", say: "zero" }];
    expect(applyPronunciations("Done. <#0.3#> Next # step", list)).toBe("Done. <#0.3#> Next hash step");
    expect(say("SQL<#0.5#>JSON")).toBe("sequel<#0.5#>Jason");
  });

  it("matches a symbol term exactly and gives it its own spaces", () => {
    const list = [{ term: "%", say: "percent" }, { term: "C#", say: "C sharp" }, { term: "->", say: "to" }];
    expect(applyPronunciations("50% done", list)).toBe("50 percent done");
    expect(applyPronunciations("Write C# today, not c#", list)).toBe("Write C sharp today, not c#");
    expect(applyPronunciations("a -> b", list)).toBe("a to b");
  });

  it("prefers the longest term and never rewrites a replacement", () => {
    const list = [{ term: "Go", say: "go lang" }, { term: "GoLand", say: "go land" }];
    expect(applyPronunciations("GoLand and Go", list)).toBe("go land and go lang");
  });

  it("handles astral characters next to a term", () => {
    expect(say("🚀SQL🚀")).toBe("🚀sequel🚀");
    expect(say("𝒳SQL")).toBe("𝒳SQL");
  });

  it("is a no-op for an empty list or text", () => {
    expect(applyPronunciations("SQL", [])).toBe("SQL");
    expect(say("")).toBe("");
    expect(findPronunciations("SQL", [])).toEqual([]);
  });

  it("pronouncer reuses one prepared list", () => {
    const run = pronouncer(DEFAULT_PRONUNCIATIONS);
    expect(run("SQL and JSON")).toBe("sequel and Jason");
    expect(run("cron")).toBe("kron");
  });
});

describe("pronunciationsFingerprint", () => {
  it("names a list by its entries, in any order, and the empty list as \"\"", () => {
    expect(pronunciationsFingerprint([])).toBe("");
    const a = pronunciationsFingerprint(DEFAULT_PRONUNCIATIONS);
    expect(a).toMatch(/^p1-9-[0-9a-f]{8}$/);
    expect(pronunciationsFingerprint([...DEFAULT_PRONUNCIATIONS].reverse())).toBe(a);
    const changed = DEFAULT_PRONUNCIATIONS.map((p) => (p.term === "REGEX" ? { term: "REGEX", say: "rej ex" } : p));
    expect(pronunciationsFingerprint(changed)).not.toBe(a);
    expect(pronunciationsFingerprint([...DEFAULT_PRONUNCIATIONS, { term: "GIF", say: "jif" }])).not.toBe(a);
  });
});

describe("checkPronunciations", () => {
  it("trims, collapses a say's spaces, and keeps symbols", () => {
    expect(checkPronunciations([{ term: "  C#  ", say: "  C   sharp " }])).toEqual({
      ok: true,
      list: [{ term: "C#", say: "C sharp" }],
    });
  });

  it("refuses duplicates without case", () => {
    const r = checkPronunciations([{ term: "SQL", say: "sequel" }, { term: "sql", say: "S Q L" }]);
    expect(r).toEqual({ ok: false, error: "sql is on the list twice." });
  });

  it("refuses blanks, spaces in a term, and bad shapes", () => {
    expect(checkPronunciations([{ term: "", say: "x" }]).ok).toBe(false);
    expect(checkPronunciations([{ term: "SQL", say: "  " }])).toEqual({ ok: false, error: "Add how to say SQL." });
    expect(checkPronunciations([{ term: "Hacker News", say: "hacker news" }]).ok).toBe(false);
    // A bad shape never reaches the rules: each boundary parses first.
    expect(PronunciationDraftListSchema.safeParse([{ term: "SQL" }]).success).toBe(false);
    expect(PronunciationDraftListSchema.safeParse("SQL").success).toBe(false);
    expect(PronunciationDraftListSchema.safeParse([null]).success).toBe(false);
    expect(PronunciationDraftListSchema.safeParse([{ term: "SQL", say: "sequel", extra: 1 }]).success).toBe(false);
  });

  it("bounds lengths and count", () => {
    expect(checkPronunciations([{ term: "x".repeat(PRONUNCIATION_TERM_MAX), say: "ok" }]).ok).toBe(true);
    expect(checkPronunciations([{ term: "x".repeat(PRONUNCIATION_TERM_MAX + 1), say: "ok" }]).ok).toBe(false);
    expect(checkPronunciations([{ term: "x", say: "y".repeat(PRONUNCIATION_SAY_MAX) }]).ok).toBe(true);
    expect(checkPronunciations([{ term: "x", say: "y".repeat(PRONUNCIATION_SAY_MAX + 1) }]).ok).toBe(false);
    const many = Array.from({ length: PRONUNCIATIONS_MAX + 1 }, (_, i) => ({ term: `t${i}`, say: "word" }));
    expect(checkPronunciations(many.slice(0, PRONUNCIATIONS_MAX)).ok).toBe(true);
    expect(checkPronunciations(many).ok).toBe(false);
  });

  it("refuses control characters and engine markup in a say", () => {
    expect(checkPronunciations([{ term: "SQL", say: "se\u0000quel" }]).ok).toBe(false);
    expect(checkPronunciations([{ term: "SQL", say: "sequel <#0.3#>" }]).ok).toBe(false);
    expect(checkPronunciations([{ term: "SQL", say: "(laughs) sequel" }]).ok).toBe(false);
    expect(checkPronunciations([{ term: "%", say: "!!" }]).ok).toBe(false);
  });

  it("refuses a say that contains a term, so the list stays idempotent", () => {
    const r = checkPronunciations([{ term: "SQL", say: "my SQL" }]);
    expect(r.ok).toBe(false);
    const cross = checkPronunciations([{ term: "SQL", say: "sequel" }, { term: "DB", say: "sequel DB" }]);
    expect(cross).toEqual({
      ok: false,
      error: "\"sequel DB\" for DB contains DB, which is also on the list.\u00a0 Spell it another way.",
    });
  });
});

describe("sanitizeStoredPronunciations", () => {
  it("keeps the valid entries of a hand-edited list and never throws", () => {
    expect(sanitizeStoredPronunciations("nope")).toBeUndefined();
    expect(sanitizeStoredPronunciations([
      { term: "SQL", say: "sequel" },
      { term: "sql", say: "again" },
      { term: "", say: "x" },
      { term: "DB", say: "the DB" },
      42,
      { term: "cron", say: "kron" },
    ])).toEqual([{ term: "SQL", say: "sequel" }, { term: "cron", say: "kron" }]);
  });
});

describe("pronounceUtterance", () => {
  it("rewrites a written utterance and keeps its spans on the original term", () => {
    const source = "Run the **SQL** migration, then check `cron`.";
    const [u] = utterancesWithSpans(source);
    expect(u.text).toBe("Run the SQL migration, then check cron.");
    const p = pronounceUtterance(u, DEFAULT_PRONUNCIATIONS);
    expect(p.text).toBe("Run the sequel migration, then check kron.");
    // Every segment is still in order and covers the text with no gaps.
    let at = 0;
    for (const seg of p.segments) {
      expect(seg.spokenStart).toBe(at);
      at = seg.spokenEnd;
    }
    expect(at).toBe(p.text.length);
    // "sequel" maps back to "SQL" in the markdown; "kron" to "cron".
    const sequel = p.segments.find((seg) => p.text.slice(seg.spokenStart, seg.spokenEnd) === "sequel");
    expect(sequel?.kind).toBe("insert");
    expect(source.slice(sequel!.srcStart, sequel!.srcEnd)).toBe("SQL");
    const kron = p.segments.find((seg) => p.text.slice(seg.spokenStart, seg.spokenEnd) === "kron");
    expect(source.slice(kron!.srcStart, kron!.srcEnd)).toBe("cron");
    // Copied prose around them still maps one for one.
    const migration = p.text.indexOf("migration");
    expect(source.slice(sourceOffsetAt(p.segments, migration), sourceOffsetAt(p.segments, migration) + 9)).toBe("migration");
  });

  it("returns the same utterance when nothing matches", () => {
    const [u] = utterancesWithSpans("Nothing to say differently here.");
    expect(pronounceUtterance(u, DEFAULT_PRONUNCIATIONS)).toBe(u);
  });
});
