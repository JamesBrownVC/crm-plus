// Pathfinder — port of Net-Work fortress.py onto the whole personal network.
// Edges carry intro-success probability p; search minimizes -ln(p) so the best
// path maximizes P = prod(p). Yen's algorithm yields K shortest SIMPLE paths.

import { computeAll } from './warmth.js';
import { scoreTarget } from './fit.js';

const SENIORITY_RANK = { IC: 0, MGR: 1, DIR: 2, VP: 3, C: 4, FOUNDER: 4, PARTNER: 4, ANGEL: 3, OTHER: 0 };
const round4 = (x) => Math.round(x * 1e4) / 1e4;
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const W_EPS = 1e-9; // floor inside -ln(p)
const TIE = 1e-12;  // float tolerance for deterministic tie-breaks

export function buildGraph(db, pathCfg, warmthMap) {
  const rows = db.prepare(
    `SELECT p.id, p.first_name, p.last_name, p.title, p.seniority, p.company_id, p.is_me,
            c.name AS company
       FROM people p LEFT JOIN companies c ON c.id = p.company_id
      ORDER BY p.id`).all();
  const nodes = new Map();
  const adj = new Map();
  let meId = null;
  for (const r of rows) {
    nodes.set(r.id, {
      id: r.id,
      name: `${r.first_name} ${r.last_name ?? ''}`.trim(),
      title: r.title ?? '',
      company_id: r.company_id,
      company: r.company ?? '',
      seniority: r.seniority,
      is_me: !!r.is_me,
    });
    adj.set(r.id, new Map());
    if (r.is_me && meId === null) meId = r.id;
  }
  const gapOf = (u, v) =>
    Math.abs((SENIORITY_RANK[nodes.get(u).seniority] ?? 0) - (SENIORITY_RANK[nodes.get(v).seniority] ?? 0));
  const relEdge = (u, v, relType, strength) => {
    const base = pathCfg.base_p[relType] ?? pathCfg.base_p.knows ?? 0.45;
    const gap = gapOf(u, v);
    const p = clip(
      base * (pathCfg.strength_factor[strength] ?? 1) * (1 - pathCfg.seniority_gap_penalty * gap),
      pathCfg.p_min, pathCfg.p_max);
    return { p, components: { rel_type: relType, base_p: base, strength, gap, p: round4(p) } };
  };
  const setIfStronger = (u, v, edge) => {
    const cur = adj.get(u).get(v);
    if (!cur || edge.p > cur.p) adj.get(u).set(v, edge);
  };
  // 1) explicit relationships, stored once, expanded to both directions
  for (const r of db.prepare('SELECT src_person, dst_person, rel_type, strength FROM relationships ORDER BY id').all()) {
    if (!nodes.has(r.src_person) || !nodes.has(r.dst_person)) continue;
    setIfStronger(r.src_person, r.dst_person, relEdge(r.src_person, r.dst_person, r.rel_type, r.strength));
    setIfStronger(r.dst_person, r.src_person, relEdge(r.dst_person, r.src_person, r.rel_type, r.strength));
  }
  // 2) implicit colleague edges inside small companies, never touching me
  const byCompany = new Map();
  for (const n of nodes.values()) {
    if (n.company_id == null) continue;
    let list = byCompany.get(n.company_id);
    if (!list) byCompany.set(n.company_id, (list = []));
    list.push(n.id);
  }
  for (const ids of byCompany.values()) {
    if (ids.length > pathCfg.colleague_company_cap) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        if (nodes.get(a).is_me || nodes.get(b).is_me) continue;
        if (adj.get(a).has(b) || adj.get(b).has(a)) continue;
        const e1 = relEdge(a, b, 'colleague', 'medium');
        const e2 = relEdge(b, a, 'colleague', 'medium');
        e1.components.implicit = true;
        e2.components.implicit = true;
        adj.get(a).set(b, e1);
        adj.get(b).set(a, e2);
      }
    }
  }
  // 3) warmth connects me directly to warm people when it beats any explicit edge
  if (meId !== null && warmthMap) {
    for (const [pid, w] of warmthMap) {
      if (!nodes.has(pid) || pid === meId || w.score < pathCfg.warm_tau) continue;
      const cur = adj.get(meId).get(pid);
      if (!cur || w.score > cur.p) {
        adj.get(meId).set(pid, {
          p: w.score,
          components: { rel_type: 'warm_contact', warmth: round4(w.score), warmth_components: w.components },
        });
      }
    }
  }
  return { nodes, adj, meId };
}

// Shortest path src->dst with at most maxHops edges, weight -ln(p).
// Layered DP (Bellman-Ford truncated at maxHops): with strictly positive
// weights the argmin walk over h <= maxHops is always a simple path.
// Deterministic: nodes relaxed in ascending id order, strict improvement only.
function shortestConstrained(adj, src, dst, maxHops, blockedEdges, blockedNodes) {
  if (maxHops <= 0 || !adj.has(src)) return null;
  const layers = [new Map([[src, 0]])];
  const parents = [new Map()];
  for (let h = 1; h <= maxHops; h++) {
    const next = new Map();
    const par = new Map();
    const us = [...layers[h - 1].keys()].sort((a, b) => a - b);
    for (const u of us) {
      const cu = layers[h - 1].get(u);
      const nbrs = adj.get(u);
      if (!nbrs) continue;
      const vs = [...nbrs.keys()].sort((a, b) => a - b);
      for (const v of vs) {
        if (blockedNodes.has(v) || blockedEdges.has(u + '>' + v)) continue;
        const c = cu - Math.log(Math.max(nbrs.get(v).p, W_EPS));
        if (!next.has(v) || c < next.get(v) - TIE) {
          next.set(v, c);
          par.set(v, u);
        }
      }
    }
    layers.push(next);
    parents.push(par);
  }
  let best = null, bestH = -1;
  for (let h = 1; h <= maxHops; h++) {
    const c = layers[h].get(dst);
    if (c !== undefined && (best === null || c < best - TIE)) { best = c; bestH = h; }
  }
  if (best === null) return null;
  const nodesArr = [dst];
  for (let h = bestH, v = dst; h > 0; h--) {
    v = parents[h].get(v);
    nodesArr.push(v);
  }
  nodesArr.reverse();
  return { nodes: nodesArr, cost: best };
}

const cmpSeq = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

function pathP(graph, nodesArr) {
  let P = 1;
  for (let i = 0; i + 1 < nodesArr.length; i++) P *= graph.adj.get(nodesArr[i]).get(nodesArr[i + 1]).p;
  return P;
}

export function kShortestPaths(graph, srcId, dstId, K, maxHops) {
  if (srcId == null || dstId == null || srcId === dstId || K <= 0) return [];
  if (!graph.adj.has(srcId) || !graph.adj.has(dstId)) return [];
  const A = [];
  const first = shortestConstrained(graph.adj, srcId, dstId, maxHops, new Set(), new Set());
  if (!first) return [];
  A.push(first);
  const candidates = new Map(); // 'u>v>...' -> {nodes, cost}
  while (A.length < K) {
    const prev = A[A.length - 1].nodes;
    for (let i = 0; i < prev.length - 1; i++) {
      const root = prev.slice(0, i + 1);
      const rootKey = root.join('>');
      // block the next edge of every accepted path sharing this root
      const blockedEdges = new Set();
      for (const a of A) {
        if (a.nodes.length > i + 1 && a.nodes.slice(0, i + 1).join('>') === rootKey) {
          blockedEdges.add(a.nodes[i] + '>' + a.nodes[i + 1]);
        }
      }
      const blockedNodes = new Set(root.slice(0, -1)); // root nodes except the spur node
      const spur = shortestConstrained(graph.adj, prev[i], dstId, maxHops - i, blockedEdges, blockedNodes);
      if (!spur) continue;
      const nodesArr = root.slice(0, -1).concat(spur.nodes);
      const key = nodesArr.join('>');
      if (candidates.has(key) || A.some((a) => a.nodes.join('>') === key)) continue;
      let rootCost = 0;
      for (let j = 0; j + 1 < root.length; j++) {
        rootCost -= Math.log(Math.max(graph.adj.get(root[j]).get(root[j + 1]).p, W_EPS));
      }
      candidates.set(key, { nodes: nodesArr, cost: rootCost + spur.cost });
    }
    if (candidates.size === 0) break;
    const sorted = [...candidates.values()].sort((x, y) =>
      Math.abs(x.cost - y.cost) < TIE ? cmpSeq(x.nodes, y.nodes) : x.cost - y.cost);
    const best = sorted[0];
    candidates.delete(best.nodes.join('>'));
    A.push(best);
  }
  return A.map((a) => ({ nodeIds: a.nodes, P: pathP(graph, a.nodes) }));
}

export function applyFailures(graph, failures, { epsilon_failed, blast_radius_alpha }) {
  for (const f of failures ?? []) {
    const out = graph.adj.get(f.src_person);
    if (!out) continue;
    const edge = out.get(f.dst_person);
    if (!edge) continue;
    edge.p = epsilon_failed;
    edge.components.failed = true;
    for (const [v, sib] of out) {
      if (v === f.dst_person) continue;
      sib.p = Math.max(epsilon_failed, sib.p * blast_radius_alpha);
      sib.components.blast_radius_damped = blast_radius_alpha;
    }
  }
  return graph;
}

function formatPath(graph, { nodeIds, P }) {
  const steps = [];
  for (let i = 0; i + 1 < nodeIds.length; i++) {
    const u = nodeIds[i], v = nodeIds[i + 1];
    const edge = graph.adj.get(u).get(v);
    const to = graph.nodes.get(v);
    steps.push({
      from_id: u,
      from: graph.nodes.get(u).name,
      to_id: v,
      to: to.name,
      to_title: to.title,
      p: round4(edge.p),
      components: edge.components,
    });
  }
  return { steps, P: round4(P), hops: steps.length };
}

function solvedGraph(db, cfgs, now) {
  const warmthMap = computeAll(db, cfgs.warmth, now);
  const graph = buildGraph(db, cfgs.path, warmthMap);
  const failures = db.prepare('SELECT src_person, dst_person FROM failed_intros').all();
  applyFailures(graph, failures, cfgs.path);
  return { graph, warmthMap };
}

export function pathsToPerson(db, targetPersonId, cfgs, now = new Date()) {
  const { graph } = solvedGraph(db, cfgs, now);
  const node = graph.nodes.get(targetPersonId);
  const target = node ? { id: node.id, name: node.name, title: node.title, company: node.company } : null;
  if (!node || graph.meId === null) return { target, paths: [] };
  const raw = kShortestPaths(graph, graph.meId, targetPersonId, cfgs.path.k_paths, cfgs.path.max_hops);
  return { target, paths: raw.map((r) => formatPath(graph, r)) };
}

export function findICP(db, criteria, cfgs, { limit = 8, order = 'rank', scope = 'all' } = {}, now = new Date()) {
  const { graph, warmthMap } = solvedGraph(db, cfgs, now);
  const companies = new Map(db.prepare('SELECT * FROM companies').all().map((c) => [c.id, c]));
  // scope: 'roster' = the working set you curated, 'network' = the bulk import,
  // 'all' = both. Sweeping the whole import finds people you have never thought
  // about; sweeping the roster re-ranks the ones you already chose.
  const where = scope === 'roster' ? "AND status = 'roster'"
    : scope === 'network' ? "AND status = 'network'" : '';
  const people = db.prepare(`SELECT * FROM people WHERE is_me = 0 ${where} ORDER BY id`).all();
  const scored = [];
  // How many people in scope even have a value for each criterion's field. A
  // sector query over an imported network matches nobody, because LinkedIn's
  // export carries no sector — saying so beats returning an empty list.
  const coverage = (Array.isArray(criteria) ? criteria : []).map((c) => ({
    id: c.id, label: c.label ?? c.field, field: c.field, known: 0,
  }));
  for (const p of people) {
    const company = p.company_id != null ? companies.get(p.company_id) ?? null : null;
    const fit = scoreTarget({ person: p, company }, criteria);
    for (const row of fit.breakdown || []) {
      const cov = coverage.find((x) => x.id === row.id);
      if (cov && row.known) cov.known++;
    }
    if (fit.score > 0) scored.push({ p, fit });
  }
  scored.sort((a, b) => b.fit.score - a.fit.score || a.p.id - b.p.id);
  const out = [];
  // Solve paths for a wider fit-ordered prefix than the result limit because
  // reach is not known yet. Rank on fit * reach, then apply the limit.
  for (const { p, fit } of scored.slice(0, limit * 3)) {
    const raw = graph.meId !== null
      ? kShortestPaths(graph, graph.meId, p.id, cfgs.path.k_paths, cfgs.path.max_hops)
      : [];
    const paths = raw.map((r) => formatPath(graph, r));
    const direct = warmthMap.get(p.id)?.score ?? 0;
    const reach_p = paths.length ? paths[0].P : 0;
    const reach = Math.max(reach_p, direct);
    const node = graph.nodes.get(p.id);
    out.push({
      person: { id: p.id, name: node.name, title: node.title, company: node.company, location: p.location ?? '' },
      fit,
      reach: round4(reach),
      reach_p: round4(reach_p),
      direct_warmth: round4(direct),
      // reach_p 0 with direct_touches 0 means "no route and no contact" — the
      // sigmoid(bias) floor, not an 8% chance of reaching them.
      direct_touches: warmthMap.get(p.id)?.touches ?? 0,
      rank_score: round4(fit.score * reach),
      paths,
    });
  }
  // 'fit': best thesis matches whether or not they have been spoken to, so the
  // caller can rank by fit and warmth independently. 'rank': fit x reach.
  out.sort(order === 'fit'
    ? (a, b) => b.fit.score - a.fit.score || b.rank_score - a.rank_score || a.person.id - b.person.id
    : (a, b) => b.rank_score - a.rank_score || a.person.id - b.person.id);
  // rows + context. `scanned` and `coverage` are what let the UI explain an empty
  // result instead of just showing one.
  return {
    rows: out.slice(0, limit),
    matched: out.length,
    scanned: people.length,
    scope,
    coverage,
  };
}
