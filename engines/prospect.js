// Prospect scoring: how close an imported contact looks to the kind of person
// worth putting on the roster, judged ONLY from what a LinkedIn export actually
// contains — their job title and their company name. Nothing else is known
// about them: no sector, no funding, no headcount, no education history (the
// export's Education.csv is the account holder's own, not their connections').
//
// So this is a keyword model over two strings, and it says so. Every point is
// attributed to the rule that awarded it, and the total is expressed as a
// percentage of the best achievable score, never as a probability of anything.
//
// The lists live in settings (key `icp_scoring`) and are meant to be edited:
// they are a user's opinion of what is interesting, not an objective ranking.

/** Strip accents/punctuation so "Équipe Exemple" matches "equipe exemple". */
export const fold = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Whole-token match, so "tech" does not fire on "biotech". */
function hasPhrase(haystack, needle) {
  const h = ` ${haystack} `;
  const n = fold(needle);
  return n.length > 0 && h.includes(` ${n} `);
}

function matchList(text, list) {
  const hits = [];
  for (const entry of list) if (hasPhrase(text, entry)) hits.push(entry);
  return hits;
}

/**
 * score({ person, company }, cfg) -> { score, points, max, breakdown }
 *  score     0..1, points / max
 *  breakdown [{ rule, label, points, evidence }] — what fired and why
 */
export function scoreProspect({ person = {}, company = null }, cfg) {
  const title = fold(person.title);
  const companyName = fold(company?.name ?? person.company_name);
  const breakdown = [];
  let points = 0;

  const award = (rule, label, pts, evidence) => {
    points += pts;
    breakdown.push({ rule, label, points: pts, evidence });
  };

  // 1. Role — the strongest honest signal in a title.
  let roleAwarded = false;
  let roleClass = 'none';
  for (const band of cfg.roles) {
    if (roleAwarded) break;
    // `exclude` stops a broader phrase swallowing a narrower one: "president" is
    // a token inside "vice president", so without this a VP reads as a CEO.
    if (band.exclude && matchList(title, band.exclude).length) continue;
    const hit = matchList(title, band.match)[0];
    if (hit) {
      award('role', band.label, band.points, `title mentions "${hit}"`);
      roleClass = band.class || 'builder';
      roleAwarded = true;
    }
  }
  if (!roleAwarded && title) {
    award('role', 'No target role in the title', 0, person.title || '');
  }

  // 2. Optional company rules can require a qualifying role first. The starter
  // profile has no company rules; an organization can configure its own.
  const roleQualifies = cfg.company_requires_role === false
    || breakdown.some((b) => b.rule === 'role' && b.points >= (cfg.company_role_min_points ?? 40));
  let companyAwarded = false;
  if (roleQualifies) {
    for (const tier of cfg.companies) {
      const hit = matchList(companyName, tier.match)[0];
      if (hit && !companyAwarded) {
        award('company', tier.label, tier.points, `company matches "${hit}"`);
        companyAwarded = true;
      }
    }
  }

  // 3. Domain — what they work on, read off the title.
  for (const dom of cfg.domains) {
    const hit = matchList(title, dom.match)[0];
    if (hit) { award('domain', dom.label, dom.points, `title mentions "${hit}"`); break; }
  }

  // 4. Optional exclusion rules (none in the starter profile).
  for (const neg of cfg.exclusions || []) {
    const hit = matchList(title, neg.match)[0];
    if (hit) { award('exclusion', neg.label, neg.points, `title mentions "${hit}"`); break; }
  }

  const max = Number(cfg.max_points) || 100;
  const clamped = Math.max(0, Math.min(points, max));
  return {
    score: Math.round((clamped / max) * 1e4) / 1e4,
    points: clamped,
    max,
    breakdown,
    // 'founder' (they run the company) vs 'builder' (they build inside one).
    role_class: roleClass,
  };
}

/**
 * Rank the network tier. Returns only people scoring at or above `min`, so the
 * caller gets a shortlist to triage rather than a large list.
 */
export function rankProspects(db, cfg, { min = 0.35, limit = 50, offset = 0, roleClass = null } = {}) {
  // Already judged people drop out: the list is a queue of open decisions, and
  // re-showing someone you rejected is how a triage list stops being used.
  const rows = db.prepare(`SELECT p.*, c.name AS company_name
                           FROM people p LEFT JOIN companies c ON c.id = p.company_id
                           WHERE p.is_me = 0 AND p.status = 'network'
                             AND NOT EXISTS (SELECT 1 FROM icp_labels l WHERE l.person_id = p.id)`).all();
  const scored = [];
  for (const p of rows) {
    const r = scoreProspect({ person: p, company: { name: p.company_name } }, cfg);
    // Filter by class BEFORE the limit: founders outscore builders by design, so
    // a shared top-N would return only founders and leave the builder list empty.
    if (roleClass && r.role_class !== roleClass) continue;
    if (r.score >= min) scored.push({ person: p, ...r });
  }
  scored.sort((a, b) => b.score - a.score || a.person.id - b.person.id);
  return { total: scored.length, rows: scored.slice(offset, offset + limit) };
}

/**
 * A sample spread evenly across the score range, for measuring the score rather
 * than using it. Judging only the top suggestions yields almost no negatives,
 * and an AUC without negatives is noise — so this deliberately includes people
 * the model rates poorly. Ignores `min`.
 */
export function spreadSample(db, cfg, { limit = 40 } = {}) {
  const rows = db.prepare(`SELECT p.*, c.name AS company_name
                           FROM people p LEFT JOIN companies c ON c.id = p.company_id
                           WHERE p.is_me = 0 AND p.status = 'network'
                             AND NOT EXISTS (SELECT 1 FROM icp_labels l WHERE l.person_id = p.id)`).all();
  const scored = rows.map((p) => ({
    person: p,
    ...scoreProspect({ person: p, company: { name: p.company_name } }, cfg),
  }));
  const BANDS = [[0, 0.15], [0.15, 0.3], [0.3, 0.45], [0.45, 0.6], [0.6, 1.01]];
  const perBand = Math.max(1, Math.round(limit / BANDS.length));
  const out = [];
  for (const [lo, hi] of BANDS) {
    const inBand = scored.filter((s) => s.score >= lo && s.score < hi);
    // even stride rather than random: same sample every time, so a number can
    // be reproduced and a second opinion compared against the first.
    const stride = Math.max(1, Math.floor(inBand.length / perBand));
    for (let i = 0, taken = 0; i < inBand.length && taken < perBand; i += stride, taken++) {
      out.push(inBand[i]);
    }
  }
  return { total: scored.length, rows: out };
}
