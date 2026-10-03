/**
 * Domains the search tool refuses outright, passed to Tavily as `excludeDomains`.
 */

export const DENIED_DOMAINS: string[] = [
  // Social and user-generated platforms
  "facebook.com",
  "instagram.com",
  "pinterest.com",
  "reddit.com",
  "quora.com",
  "zhihu.com",

  // Self-publishing and document dumps — no editorial review
  "medium.com",
  "scribd.com",
  "vocal.media",

  // Retail and entertainment listings
  "amazon.com",
  "gamespot.com",

  // Counterfactual fiction presented in the same format as scholarship.
  "alternatehistory.com",
  "thisdayinalternatehistory.blogspot.com",
  "fandom.com",

  // Individual sites observed returning content unrelated to military history
  "kb.freeportstore.com",
  "foleyfamilymedicine.com",
  "brucewilsonauthor.com",
];
