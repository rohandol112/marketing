import { generateJson, generateGrounded } from './llm.js';
import { gapsFrom, explainScore } from './scoring.js';
import { buildSystemPrompt } from './systemPrompt.js';
export { buildSystemPrompt };

/**
 * Every prompt in one file, each with three parts that always travel together:
 * a schema, a fallback, and the prompt itself. If you add a generator without a
 * fallback, a bad minute at the provider becomes a blank screen for a rep.
 *
 * The system prompt is built once per tenant and reused byte-identically, which
 * is what lets implicit prompt caching actually hit. Do not interpolate
 * anything lead-specific into it.
 */

function fmt(n) {
  return n == null ? '?' : Number(n).toLocaleString('en-IN');
}

/** The lead facts, in one consistent shape for every prompt. */
export function leadContext(lead, extras = {}) {
  const b = lead.score_breakdown || {};
  const lines = [
    'Business: ' + lead.name,
    'Category: ' + (lead.category || lead.normalized_category || 'unknown'),
    'Area: ' + [lead.locality, lead.region, lead.country_code].filter(Boolean).join(', ') || (lead.address || 'unknown'),
    'Google reviews: ' + (lead.review_count ?? 'UNKNOWN - nobody has checked') + (lead.rating ? ' at ' + lead.rating + ' stars' : ''),
    'Website: ' + websiteLine(lead),
    'Instagram followers: ' + (lead.ig_followers ?? 'UNKNOWN - not checked'),
    'LinkedIn followers: ' + (lead.li_followers ?? 'UNKNOWN - not checked'),
    'Data confidence: ' + (lead.confidence ?? '?') + '% - how much of this record is actually evidenced',
    'Years in business: ' + (lead.years_in_business ?? 'unknown'),
    'Locations: ' + (lead.locations_count ?? 'unknown'),
    'Lead score: ' + lead.score + ' out of 100, tier ' + lead.tier,
  ];

  const signals = explainScore(b);
  if (signals.length) {
    lines.push('', 'OBSERVED SIGNALS (these are the only facts you may reason from):');
    for (const s of signals) lines.push('- ' + s);
  }

  const auditSignals = lead.website_audit?.signals || [];
  if (auditSignals.length) {
    lines.push('', 'WEBSITE AUDIT FINDINGS:');
    for (const s of auditSignals.slice(0, 8)) lines.push('- ' + s);
  }

  if (extras.activities?.length) {
    lines.push('', 'RECENT ACTIVITY (most recent first):');
    for (const a of extras.activities.slice(0, 5)) {
      lines.push('- ' + a.occurred_at?.slice(0, 10) + ' ' + a.type + (a.outcome ? ' (' + a.outcome + ')' : '') + ': ' + (a.body || '').slice(0, 300));
    }
  }

  if (extras.research) {
    const r = extras.research;
    lines.push('', 'RESEARCH (searched the web just now - real and cited):');
    if (r.summary) lines.push('- ' + r.summary);
    for (const x of (r.size_signals || []).slice(0, 5)) lines.push('- Scale: ' + x);
    for (const x of (r.services || []).slice(0, 6)) lines.push('- Offers: ' + x);
    if (r.digital_presence?.website) lines.push('- Website found: ' + r.digital_presence.website);
    if (r.digital_presence?.instagram) {
      lines.push(
        '- Instagram: ' + r.digital_presence.instagram +
        (r.digital_presence.followers_estimate ? ' (about ' + r.digital_presence.followers_estimate + ' followers)' : '')
      );
    }
    for (const x of (r.recent || []).slice(0, 3)) lines.push('- Recent: ' + x);
    if (r.buying_trigger) lines.push('- Possible trigger: ' + r.buying_trigger);
  }

  if (extras.patterns) lines.push('', 'WHAT HAS WORKED IN THIS CATEGORY:', extras.patterns);

  return lines.join('\n');
}

/** Unknown and absent are different facts, and the model must never conflate them. */
function websiteLine(lead) {
  if (lead.website_status === 'unknown') {
    return 'UNKNOWN - nobody has checked. Do NOT claim they have no website.';
  }
  if (lead.website_status === 'none') return 'confirmed none - an authoritative source says they have no website';
  if (lead.website_status === 'social_only') return 'uses a social page as their website - they own no site of their own';
  if (!lead.website) return 'UNKNOWN';
  return lead.website_status + (lead.website_audit?.builder ? ' (built on ' + lead.website_audit.builder + ')' : '');
}

/* ================================================================== */
/* 0. Grounded research - runs before the brief                       */
/* ================================================================== */

const RESEARCH_SHAPE = {
  summary: 'two sentences on what this business actually is',
  services: ['what they sell'],
  size_signals: ['anything indicating scale: outlets, staff, beds, years trading'],
  digital_presence: {
    website: 'url or null',
    instagram: 'handle or null',
    followers_estimate: 'number or null',
    facebook: 'handle or null',
  },
  contact: {
    phone: 'their public business phone, ONLY if you found it on a page you can cite, else null',
    phone_source: 'the exact URL you read the number from, else null',
    google_reviews: 'their Google review count as a number, only if you saw it, else null',
    google_rating: 'their Google rating, only if you saw it, else null',
  },
  recent: ['anything from the last year worth mentioning on a call'],
  buying_trigger: 'one reason now might be a good moment to call, or null',
  confidence: 'high | medium | low - how much did you actually find',
};

const RESEARCH_SYSTEM = [
  'You research a local business so a sales rep can have an informed first conversation.',
  '',
  'Rules:',
  '1. Only state what you found in search results. If you did not find something, use null. A short accurate result beats a padded one.',
  '2. A phone number is allowed ONLY when you read it on a specific page and can give that exact URL in phone_source. If you cannot cite it, phone must be null. Never reconstruct or guess a number - a wrong one means a rep calls a stranger.',
  '3. Follower counts must come from a source, never a number you estimated. Null is the correct answer when unsure.',
  '4. Do not confuse this business with a similarly named one elsewhere. If you cannot confirm this specific location, set confidence to low.',
].join('\n');

/**
 * Search the web for real, cited facts before briefing on a lead.
 *
 * This is the step that turns a brief from "reasonable-sounding advice about a
 * category" into "this hospital has 314 beds and 26.7k Instagram followers".
 * It needs billing enabled; without it the call degrades to an empty research
 * object and the brief runs on scored observations exactly as before.
 */
export async function researchBusiness({ lead }) {
  const where = [lead.locality, lead.region, lead.country_code].filter(Boolean).join(', ');
  const user = [
    'Research this business:',
    'Name: ' + lead.name,
    'Type: ' + (lead.category || lead.normalized_category || 'local business'),
    'Location: ' + (where || lead.address || 'unknown'),
    lead.website ? 'Known website: ' + lead.website : '',
    '',
    'Find what they actually do, how big they are, their real online presence including social handles and follower counts, and anything recent worth knowing on a sales call.',
  ].filter(Boolean).join('\n');

  return generateGrounded({
    system: RESEARCH_SYSTEM,
    user,
    shape: RESEARCH_SHAPE,
    temperature: 0.2,
    // Research output is internal evidence with citations, not customer-facing
    // copy. It is gated by the candidates flow, not by scrubbing.
    raw: true,
    fallback: () => ({
      summary: null, services: [], size_signals: [],
      digital_presence: {}, recent: [], confidence: 'low',
    }),
  });
}


/* ================================================================== */
/* 0b. Social enrichment - the columns nothing else can fill          */
/* ================================================================== */

const SOCIAL_SHAPE = {
  instagram_handle: 'handle without @, or null',
  instagram_followers: 'number only, from a page you can cite, else null',
  facebook_handle: 'page name or null',
  facebook_followers: 'number or null',
  linkedin_url: 'company page URL or null',
  linkedin_followers: 'number or null',
  years_in_business: 'number of years trading, or null',
  founded_year: 'four digit year, or null',
  locations_count: 'how many branches or outlets, or null',
  evidence: 'one line naming where the follower numbers came from',
};

const SOCIAL_SYSTEM = [
  'You find the public social media presence of a local business.',
  '',
  'Rules:',
  '1. Search before answering. Report only what you actually found.',
  '2. Follower counts must come from a page you saw. Never estimate, never round a number you did not read. null is the correct answer when unsure.',
  '3. Make sure it is the right business - same name AND same city. A national brand with a similar name is the wrong answer.',
  '4. Never return a phone number or an email address here.',
  '5. If you find nothing, return nulls. An empty honest answer is worth more than a plausible invented one.',
].join('\n');

/**
 * Instagram and LinkedIn follower counts have no lawful third-party API worth
 * building on: the Graph API needs the business to grant access, and scraping
 * profiles breaks Meta terms and gets blocked within weeks. Search is the one
 * route that stays legitimate and keeps working.
 *
 * It is deliberately narrower than researchBusiness - one job, small prompt,
 * cheap enough to run over a whole sweep.
 */
export async function enrichSocial({ lead }) {
  const where = [lead.locality, lead.region].filter(Boolean).join(', ');
  const user = [
    'Find the social media presence of this business.',
    'Name: ' + lead.name,
    'Type: ' + (lead.category || 'local business'),
    'Location: ' + (where || lead.address || 'unknown'),
    lead.website ? 'Website: ' + lead.website : '',
    '',
    'Find their Instagram, Facebook and LinkedIn, with follower counts where a page shows them.',
    'Also find how long they have been trading and how many branches they have.',
  ].filter(Boolean).join('\n');

  return generateGrounded({
    system: SOCIAL_SYSTEM,
    user,
    shape: SOCIAL_SHAPE,
    temperature: 0.1,
    raw: true,
    fallback: () => ({
      instagram_handle: null, instagram_followers: null,
      linkedin_followers: null, years_in_business: null, locations_count: null,
    }),
  });
}

/* ================================================================== */
/* 1. Pre-call brief                                                  */
/* ================================================================== */

const BRIEF_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING', description: 'One sentence a rep can read in three seconds: what this business is and why it is worth calling.' },
    gaps: {
      type: 'ARRAY',
      minItems: 2,
      items: {
        type: 'OBJECT',
        properties: {
          gap: { type: 'STRING', description: 'The gap, in plain words' },
          why_it_matters: { type: 'STRING', description: 'What it is costing them, concretely' },
          service: { type: 'STRING', description: 'Which service from the catalogue answers it' },
        },
        required: ['gap', 'why_it_matters', 'service'],
      },
    },
    decision_maker: { type: 'STRING', description: 'Best guess at who to ask for, and say plainly if it is a guess' },
    best_channel: { type: 'STRING', enum: ['whatsapp', 'phone', 'walk_in', 'email', 'instagram_dm'] },
    best_time: { type: 'STRING', description: 'When to reach them, reasoned from the category' },
    opener: { type: 'STRING', description: 'The first two sentences, spoken out loud. Under 45 words.' },
    recommended_package_id: { type: 'STRING' },
    price_band: { type: 'STRING', description: 'The range to anchor on, from the package list' },
    objection_to_expect: { type: 'STRING' },
    objection_response: { type: 'STRING' },
    do_not_say: { type: 'STRING', description: 'One thing that would kill this specific call' },
  },
  required: ['headline', 'gaps', 'decision_maker', 'best_channel', 'best_time', 'opener', 'recommended_package_id', 'price_band', 'objection_to_expect', 'objection_response'],
  propertyOrdering: ['headline', 'gaps', 'decision_maker', 'best_channel', 'best_time', 'opener', 'recommended_package_id', 'price_band', 'objection_to_expect', 'objection_response', 'do_not_say'],
};

function pickPackage(lead, packages) {
  const sorted = [...packages].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (!sorted.length) return null;
  if (lead.tier === 'A') return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.7))];
  if (lead.tier === 'B') return sorted[Math.floor(sorted.length * 0.4)];
  return sorted[0];
}

function briefFallback(lead, packages) {
  const gaps = gapsFrom(lead.score_breakdown).slice(0, 3);
  const pkg = pickPackage(lead, packages);
  return {
    headline:
      lead.name + ' has ' + (lead.review_count ?? 'a number of') + ' Google reviews and ' +
      (lead.website_status === 'none' ? 'no website' : 'a ' + (lead.website_status || 'thin') + ' website') + '.',
    gaps: (gaps.length ? gaps : ['Digital presence not yet reviewed']).map((g) => ({
      gap: g,
      why_it_matters: 'Customers looking for them online do not find what the business actually is.',
      service: 'Custom Website Development',
    })),
    decision_maker: 'Owner or proprietor (guess - confirm on the call)',
    best_channel: 'whatsapp',
    best_time: 'Late morning, before the lunch rush',
    opener:
      'Hi, I was looking at ' + lead.name + ' on Google - ' + (lead.review_count ?? 'plenty of') +
      ' reviews is a lot of happy customers. I noticed ' + (gaps[0] || 'a few gaps online') + '. Worth two minutes?',
    recommended_package_id: pkg ? pkg.id : '',
    price_band: pkg ? pkg.currency + ' ' + fmt(pkg.price_min) + ' to ' + fmt(pkg.price_max) : 'To be set',
    objection_to_expect: 'We already tried this and it did not work',
    objection_response: 'Ask what exactly was tried and what the result was. Usually it was posting without a plan.',
    do_not_say: 'Do not tell them their business looks unprofessional.',
    _template: true,
  };
}

export async function generatePrecallBrief({ tenant, catalog, packages, lead, research }) {
  const system = buildSystemPrompt(tenant, catalog, packages);
  const user = [
    'Write a pre-call brief for this lead.',
    '',
    leadContext(lead, { research }),
    '',
    'The opener must contain at least one specific number or fact from above. A rep should be able to read it aloud and have the owner think "they actually looked at us".',
    'Lead with the single gap where the distance between what they earned offline and what they claimed online is widest. Do not list every gap - name the one worth the call.',
    'If the evidence above is thin, write a shorter brief and say what is unknown. Do not pad.',
  ].join('\n');

  return generateJson({
    system,
    user,
    schema: BRIEF_SCHEMA,
    fallback: () => briefFallback(lead, packages),
    temperature: 0.5,
  });
}

/* ================================================================== */
/* 2. WhatsApp opener                                                 */
/* ================================================================== */

const WA_SCHEMA = {
  type: 'OBJECT',
  properties: {
    message: { type: 'STRING', description: 'The opening message. Under 60 words. No links, no phone numbers, no emoji spam. One question at the end.' },
    follow_up_if_no_reply: { type: 'STRING', description: 'Sent 3 days later if they do not reply. Different angle, not a nudge.' },
    why_this_angle: { type: 'STRING', description: 'One line for the rep, not for the customer' },
  },
  required: ['message', 'follow_up_if_no_reply', 'why_this_angle'],
  propertyOrdering: ['message', 'follow_up_if_no_reply', 'why_this_angle'],
};

function waFallback(lead, tenant) {
  const gaps = gapsFrom(lead.score_breakdown);
  return {
    message:
      'Hi, this is {{repName}} from ' + tenant.name + '. I came across ' + lead.name +
      ' on Google - ' + (lead.review_count ?? 'a lot of') + ' reviews is genuinely hard to earn. ' +
      'One thing stood out: ' + (gaps[0] || 'your online presence has room to grow') +
      '. Would it be alright if I sent over a short breakdown?',
    follow_up_if_no_reply:
      'Hi again - no pressure at all. I put together a two-page look at how ' + lead.name +
      ' shows up online versus what you have actually built. Happy to send it across if it is useful.',
    why_this_angle: 'Leads with the review count as proof of trust, then names one gap as upside.',
    _template: true,
  };
}

export async function generateWhatsappOpener({ tenant, catalog, packages, lead }) {
  const system = buildSystemPrompt(tenant, catalog, packages);
  const user = [
    'Write a first WhatsApp message to this business, and a follow-up for three days later.',
    '',
    leadContext(lead),
    '',
    'It is a cold message from a stranger. It must earn the second sentence.',
    'Use {{repName}} where the rep name goes. Never write a link or a phone number.',
  ].join('\n');

  return generateJson({
    system,
    user,
    schema: WA_SCHEMA,
    fallback: () => waFallback(lead, tenant),
    temperature: 0.6,
  });
}

/* ================================================================== */
/* 3. Call note extraction                                            */
/* ================================================================== */

const NOTE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: 'Two sentences maximum' },
    objections: { type: 'ARRAY', items: { type: 'STRING' } },
    budget_signal: { type: 'STRING', enum: ['none', 'no_budget', 'price_sensitive', 'budget_exists', 'budget_confirmed'] },
    buying_signal: { type: 'STRING', enum: ['cold', 'curious', 'engaged', 'evaluating', 'ready'] },
    sentiment: { type: 'STRING', enum: ['negative', 'neutral', 'positive'] },
    outcome: { type: 'STRING', enum: ['connected', 'no_answer', 'interested', 'not_interested', 'callback', 'meeting_set'] },
    next_step: { type: 'STRING', description: 'The single concrete next action' },
    next_due_in_days: { type: 'NUMBER', description: 'Days until the next action is due' },
    suggested_stage: { type: 'STRING', enum: ['todo', 'in_discussion', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'success', 'failed'] },
  },
  required: ['summary', 'objections', 'budget_signal', 'buying_signal', 'sentiment', 'outcome', 'next_step', 'next_due_in_days', 'suggested_stage'],
};

function noteFallback(note) {
  return {
    summary: String(note || '').slice(0, 200),
    objections: [],
    budget_signal: 'none',
    buying_signal: 'curious',
    sentiment: 'neutral',
    outcome: 'connected',
    next_step: 'Follow up and confirm interest',
    next_due_in_days: 3,
    suggested_stage: 'in_discussion',
    _template: true,
  };
}

export async function extractCallNote({ tenant, catalog, packages, lead, note }) {
  const system = buildSystemPrompt(tenant, catalog, packages);
  const user = [
    'A rep just logged this note after contacting the business. Turn it into structured data.',
    'Do not invent anything the note does not say. If a field is not evidenced, use the most neutral option.',
    '',
    leadContext(lead),
    '',
    'REP NOTE:',
    String(note || '').slice(0, 4000),
  ].join('\n');

  return generateJson({
    system,
    user,
    schema: NOTE_SCHEMA,
    fallback: () => noteFallback(note),
    fast: true,
    temperature: 0.1,
  });
}

/* ================================================================== */
/* 4. Stage-aware next step                                           */
/* ================================================================== */

const NEXT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    angle: { type: 'STRING', description: 'The move to make at this stage, one sentence' },
    message: { type: 'STRING', description: 'A ready-to-send message. Under 70 words.' },
    what_to_send: { type: 'STRING', description: 'The artefact that should go with it, or "nothing"' },
    risk: { type: 'STRING', description: 'Why this lead might be about to go cold' },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
  },
  required: ['angle', 'message', 'what_to_send', 'risk', 'confidence'],
};

const STAGE_PLAYBOOK = {
  todo: 'First contact has not happened. The move is to open, not to sell.',
  in_discussion: 'They replied. The move is to find the actual problem behind the polite interest.',
  follow_up_1: 'Give value with no ask attached: a free mini audit or a sample creative.',
  follow_up_2: 'Social proof. The nearest comparable business in the same category that got a result.',
  follow_up_3: 'Last touch. Either a clean breakup message, or a downgrade to the smallest package.',
  success: 'Closed. The move is onboarding, then the upsell ladder, then the referral ask.',
  failed: 'Lost. Capture why, precisely enough to be useful in three months.',
};

function nextFallback(lead, stage) {
  return {
    angle: STAGE_PLAYBOOK[stage] || 'Follow up.',
    message: 'Hi, following up on my last message about ' + lead.name + '. Is this still worth a conversation, or should I close the file?',
    what_to_send: stage === 'follow_up_1' ? 'A one-page audit of their online presence' : 'nothing',
    risk: (lead.activity_count || 0) > 3 ? 'Several touches with no commitment - this is drifting.' : 'Too early to tell.',
    confidence: 'low',
    _template: true,
  };
}

export async function suggestNextStep({ tenant, catalog, packages, lead, stage, activities, patterns }) {
  const system = buildSystemPrompt(tenant, catalog, packages);
  const user = [
    'This lead is at stage: ' + stage,
    'Playbook for this stage: ' + (STAGE_PLAYBOOK[stage] || 'Move it forward.'),
    '',
    leadContext(lead, { activities, patterns }),
    '',
    'Stage alone is a weak signal. Reason from what actually happened in the activity log.',
    'If the log shows this lead is going nowhere, say so in the risk field rather than writing an optimistic message.',
  ].join('\n');

  return generateJson({
    system,
    user,
    schema: NEXT_SCHEMA,
    fallback: () => nextFallback(lead, stage),
    temperature: 0.5,
  });
}

export { STAGE_PLAYBOOK, BRIEF_SCHEMA, WA_SCHEMA, NOTE_SCHEMA, NEXT_SCHEMA };
