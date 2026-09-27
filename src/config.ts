export const TAVILY_MAX_RESULTS = 4;

// --- Pre-research phase (scoping and plan confirmation) ---

// How many suggestive nudges the user gets before the graph gives up and ends.
export const MAX_CLARIFY_ROUNDS = 3;

// How many plans the user may reject before the next one is auto-accepted.
export const MAX_CONFIRM_ROUNDS = 6;

// Upper bound on how many angles a proposed plan carries. Each angle is intended to become
// one ConductResearch call, so this is deliberately aligned with MAX_CONCURRENT_RESEARCH_UNITS.
//
// It is a ceiling, not a quota: propose_plan may return fewer. A topic that only supports two
// angles worth researching should get two, because a padded third is a wasted researcher and
// a report section that says nothing.
export const MAX_ANGLES_PER_PLAN = 3;

// --- Research phase ---

export const MAX_SUPERVISOR_TURNS = 5;
export const MAX_CONCURRENT_RESEARCH_UNITS = 3;

export const MAX_RESEARCHER_TURNS = 5;
export const MAX_CONCURRENT_TAVILY_SEARCHES = 4;
