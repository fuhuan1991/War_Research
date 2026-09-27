/**
 * Substitutes `{placeholder}` slots in a prompt template.
 *
 * Replaces a chain of `.replace("{x}", value)` calls, which had two bugs — both reachable
 * from content the system does not control, since the values include the user's own
 * messages and web page text scraped by Tavily:
 *
 * 1. `String.prototype.replace` interprets `$` patterns in a STRING replacement. A value
 *    containing `$&` inserted the matched placeholder, and `$'` spliced in the entire
 *    remainder of the prompt — so one stray `$'` in a search result duplicated the tail of
 *    the report prompt. (`$1` was harmless here: with a string pattern there are no capture
 *    groups, so it stays literal.) A replacer FUNCTION is exempt from that expansion.
 *
 * 2. Chained calls re-scan text that earlier calls injected, so a value containing a later
 *    placeholder captured that substitution. A `rough_topic` containing the literal
 *    `{messages}` swallowed the conversation history and left the real slot unfilled.
 *    Substituting in a single pass makes injected text inert.
 *
 * Unknown placeholders are left untouched rather than blanked, so a mistyped key shows up
 * in the prompt as `{typo}` instead of silently deleting the slot.
 */
export const fillTemplate = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
