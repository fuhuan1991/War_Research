import { describe, it, expect } from "vitest";
import { fillTemplate } from "../../src/prompts/fillTemplate.js";

// =============================================================================
// These are regression tests for two bugs in the chained `.replace("{x}", v)`
// calls that fillTemplate replaced. Both were reachable from content the system
// does not control — user messages, and web page text scraped by Tavily into
// the report prompt's {findings} slot — so they are worth pinning down.
// =============================================================================

describe("fillTemplate: values are inserted literally", () => {
  // String.prototype.replace expands $ patterns in a STRING replacement. These
  // three did real damage; a replacer function is exempt from the expansion.
  it("does not expand $& (which used to insert the placeholder itself)", () => {
    expect(fillTemplate("<{a}>", { a: "costs $& rose" })).toBe("<costs $& rose>");
  });

  it("does not expand $' (which used to splice in the rest of the prompt)", () => {
    // The worst of the three: one stray $' duplicated everything after the slot.
    expect(fillTemplate("<{a}>TAIL", { a: "see $' here" })).toBe("<see $' here>TAIL");
  });

  it("does not expand $` or $$", () => {
    expect(fillTemplate("HEAD<{a}>", { a: "x $` y $$ z" })).toBe("HEAD<x $` y $$ z>");
  });

  it("leaves $1 alone, as the old code also did", () => {
    // Called out in review as a bug; it never was one. With no capture groups a
    // numbered reference stays literal. Pinned so the claim stops resurfacing.
    expect(fillTemplate("<{a}>", { a: "$1 billion" })).toBe("<$1 billion>");
  });
});

describe("fillTemplate: substitution happens in one pass", () => {
  it("does not substitute into text it just inserted", () => {
    // A rough_topic containing the literal {messages} used to swallow the
    // conversation history and leave the real slot unfilled.
    expect(fillTemplate("<{a}>|<{b}>", { a: "war and {b}", b: "HISTORY" })).toBe(
      "<war and {b}>|<HISTORY>",
    );
  });

  it("is unaffected by the order keys are declared in", () => {
    const tpl = "<{a}>|<{b}>";
    expect(fillTemplate(tpl, { a: "A", b: "B" })).toBe(fillTemplate(tpl, { b: "B", a: "A" }));
  });
});

describe("fillTemplate: ordinary behaviour", () => {
  it("fills every occurrence of a placeholder", () => {
    expect(fillTemplate("{a} and {a}", { a: "x" })).toBe("x and x");
  });

  it("leaves unknown placeholders intact rather than blanking them", () => {
    // So a mistyped key is visible in the prompt instead of silently deleting it.
    expect(fillTemplate("{known} {unknown}", { known: "ok" })).toBe("ok {unknown}");
  });

  it("ignores braces that are not simple placeholders", () => {
    expect(fillTemplate('{ "json": 1 } and {}', { json: "nope" })).toBe('{ "json": 1 } and {}');
  });

  it("accepts an empty value", () => {
    expect(fillTemplate("<{a}>", { a: "" })).toBe("<>");
  });
});
