// Allocator — port of Net-Work allocator.py solve_greedy (no OR-Tools).
// Picks at most one action per company to maximize estimated priority uplift per hour.

import { companyWarmth, companyTouches } from './warmth.js';

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 1e4) / 1e4;

const STAGE_WEIGHT = { sourced: 0.6, contacted: 0.8, meeting: 1.0, diligence: 1.2, referred: 0.7 };

function activeDeals(db) {
  return db.prepare(
    `SELECT d.id AS deal_id, d.company_id, d.stage, d.priority, d.next_step, c.name AS company
       FROM deals d JOIN companies c ON c.id = d.company_id
      WHERE d.stage NOT IN ('won', 'passed')
      ORDER BY d.id`).all();
}

function peopleByCompany(db) {
  const map = new Map();
  for (const r of db.prepare('SELECT id, company_id FROM people WHERE company_id IS NOT NULL').all()) {
    let list = map.get(r.company_id);
    if (!list) map.set(r.company_id, (list = []));
    list.push(r);
  }
  return map;
}

export function buildCandidates(db, cfgs, warmthMap) {
  const { actions, uplifts } = cfgs;
  const byCompany = peopleByCompany(db);
  const { cold, warm } = uplifts.buckets.warmth;
  const out = [];
  for (const d of activeDeals(db)) {
    const ppl = byCompany.get(d.company_id) ?? [];
    const w = companyWarmth(warmthMap, ppl);
    const touches = companyTouches(warmthMap, ppl);
    const wb = w < cold ? 'cold' : w < warm ? 'warm' : 'hot';
    // Conviction (the 1-5 stars you set on the deal) is the weight. There used to
    // be a euro figure here, mapped from conviction through a made-up table — it
    // read as a forecast while being pure invention, so it is gone. Conviction
    // still decides which deal is worth the hour; it just no longer pretends to
    // be money.
    const conviction = Math.min(5, Math.max(1, Number(d.priority) || 3));
    const vt = conviction <= 2 ? 'low' : conviction <= 3 ? 'mid' : 'high';
    for (const [action, spec] of Object.entries(actions)) {
      const delta = uplifts.table?.[action]?.[wb]?.[vt] ?? uplifts.default;
      out.push({
        deal_id: d.deal_id,
        company_id: d.company_id,
        company: d.company,
        action,
        // TOP level, never inside `components` (whose shape callers deepEqual): a
        // plan item for a company with zero recorded people has nobody to act on,
        // and the row must be able to say so.
        people_count: ppl.length,
        hours: spec.hours,
        delta_p: delta,
        conviction,
        // ranking score, unitless: odds gained x how much you believe in the deal
        u: round4(delta * conviction),
        components: { warmth: round4(w), warmth_touches: touches, warmth_bucket: wb, conviction_tier: vt, delta_p: delta, conviction, hours: spec.hours },
      });
    }
  }
  return out;
}

export function weeklyPlan(db, cfgs, warmthMap, hoursBudget) {
  const ratio = (c) => c.u / Math.max(c.hours, 0.1);
  const ranked = buildCandidates(db, cfgs, warmthMap)
    .filter((c) => c.u > 0)
    .sort((a, b) =>
      ratio(b) - ratio(a) ||
      b.u - a.u ||
      a.company_id - b.company_id ||
      (a.action < b.action ? -1 : a.action > b.action ? 1 : 0));
  const plan = [];
  const taken = new Set();
  let hours = 0;
  for (const c of ranked) {
    if (taken.has(c.company_id) || hours + c.hours > hoursBudget) continue;
    plan.push(c);
    taken.add(c.company_id);
    hours += c.hours;
  }
  return { plan, budget: { hours_used: round2(hours), hours_budget: hoursBudget } };
}

export function priorities(db, cfgs, warmthMap, now = new Date()) {
  const { cadence } = cfgs;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const byCompany = peopleByCompany(db);
  const lastByCompany = new Map();
  for (const r of db.prepare(
    `SELECT p.company_id, MAX(i.ts) AS last_ts
       FROM interactions i JOIN people p ON p.id = i.person_id
      WHERE p.company_id IS NOT NULL GROUP BY p.company_id`).all()) {
    lastByCompany.set(r.company_id, r.last_ts);
  }
  const out = activeDeals(db).map((d) => {
    const lastTs = lastByCompany.get(d.company_id) ?? null;
    const days = lastTs !== null ? (nowMs - Date.parse(lastTs)) / 86400e3 : 999;
    const target = cadence[d.stage] ?? 14;
    const staleness = days / target;
    const score = (d.priority / 5) * (STAGE_WEIGHT[d.stage] ?? 1.0) * Math.min(staleness, 3);
    const reason = lastTs !== null
      ? `${Math.round(days)}d since last touch (target ${target}d) at ${d.stage} stage`
      : `never touched (target ${target}d) at ${d.stage} stage`;
    return {
      deal_id: d.deal_id,
      company_id: d.company_id,
      company: d.company,
      stage: d.stage,
      priority: d.priority,
      // "nobody recorded here yet" is part of the recommendation: a top-of-queue company
      // with zero people gives the user no one to log the touch against.
      people_count: (byCompany.get(d.company_id) ?? []).length,
      days_since: round1(days),
      staleness: round4(staleness),
      score: round4(score),
      reason,
      next_step: d.next_step ?? '',
    };
  });
  out.sort((a, b) => b.score - a.score || a.deal_id - b.deal_id);
  return out;
}

// Person-level decay: `priorities` only walks deals, so a high-warmth contact at
// a company with no deal can never surface. Same shape of reasoning as
// `priorities`, one target cadence for everyone, and the same min(overdue, 3) cap
// so a contact ignored for two years cannot permanently own the card.
// The effective target the engine used. Exported so a caller can label the card
// ("target 45d") even when the list comes back empty and no row carries it.
export function quietTargetDays(cfgs) {
  const t = Number(cfgs?.quiet?.target_days);
  return t > 0 ? t : 45;
}

export function goingQuietAll(db, cfgs, warmthMap, now = new Date()) {
  const q = cfgs?.quiet ?? {};
  const target = quietTargetDays(cfgs);
  const minWarmth = Number.isFinite(Number(q.min_warmth)) ? Number(q.min_warmth) : 0.35;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const lastByPerson = new Map();
  for (const r of db.prepare(
    'SELECT person_id, MAX(ts) AS last_ts FROM interactions GROUP BY person_id').all()) {
    lastByPerson.set(r.person_id, r.last_ts);
  }
  const out = [];
  for (const p of db.prepare(
    `SELECT p.id, p.first_name, p.last_name, p.title, p.seniority, p.company_id,
            c.name AS company_name
       FROM people p LEFT JOIN companies c ON c.id = p.company_id
      -- roster only: a bulk-imported contact you once exchanged a message with
      -- has not "gone quiet on you", and a large import would bury the handful
      -- of relationships you are actually trying to keep alive.
      WHERE p.is_me = 0 AND p.status = 'roster' ORDER BY p.id`).all()) {
    const w = warmthMap.get(p.id);
    const touches = w?.touches ?? 0;
    if (!w || touches < 1) continue; // never contacted: has not "gone quiet"
    const lastTs = lastByPerson.get(p.id) ?? null;
    if (lastTs === null) continue;
    const days = (nowMs - Date.parse(lastTs)) / 86400e3;
    if (!Number.isFinite(days)) continue;
    const overdue = days / target;
    if (w.score < minWarmth || overdue < 1) continue;
    out.push({
      id: p.id,
      name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
      title: p.title ?? '',
      company_id: p.company_id ?? null,
      company_name: p.company_name ?? null,
      seniority: p.seniority ?? '',
      warmth: round4(w.score),
      touches,
      last_touch: lastTs,
      days_since: round1(days),
      target_days: target,
      overdue: round4(overdue),
      quiet_score: round4(w.score * Math.min(overdue, 3)),
      reason: `${Math.round(days)}d since last touch (target ${target}d)`,
    });
  }
  out.sort((a, b) => b.quiet_score - a.quiet_score || a.id - b.id);
  return out;
}

// The page, not the set: callers that show "Going quiet · N" need goingQuietAll's
// length for N, or the card claims the page size is the number of people going cold.
export function goingQuiet(db, cfgs, warmthMap, now = new Date(), { limit = 6 } = {}) {
  return goingQuietAll(db, cfgs, warmthMap, now).slice(0, limit);
}
