import type {
  DedupConfig,
  DuplicateCluster,
  DuplicateClusterMember,
  DuplicateReport,
  NormalizedEntity,
  PlanOp,
  ReviewPair,
} from './model.js';
import { match, pickCanonical, type MatchResult } from './matcher.js';

/**
 * Inbound relation index: who points at `entityId` (built from a full space
 * snapshot by scanning every entity's outbound relations).
 */
export function buildInboundIndex(entities: readonly NormalizedEntity[]): Map<string, Array<{ relationId?: string | undefined; typeId: string; fromEntityId: string }>> {
  const inbound = new Map<string, Array<{ relationId?: string | undefined; typeId: string; fromEntityId: string }>>();
  for (const e of entities) {
    for (const r of e.relations) {
      const list = inbound.get(r.toEntityId) ?? [];
      list.push({ relationId: r.id, typeId: r.typeId, fromEntityId: e.id });
      inbound.set(r.toEntityId, list);
    }
  }
  return inbound;
}

function opsForDuplicate(
  member: NormalizedEntity,
  canonical: NormalizedEntity,
  inbound: Map<string, Array<{ relationId?: string | undefined; typeId: string; fromEntityId: string }>>,
): PlanOp[] {
  if (member.isDraft) {
    return [
      {
        kind: 'skipDraft',
        draftRef: member.id,
        canonicalId: canonical.id,
        note: `draft "${member.name}" duplicates existing "${canonical.name}" — do not publish, link to canonical instead`,
      },
    ];
  }
  const ops: PlanOp[] = [];
  for (const link of inbound.get(member.id) ?? []) {
    ops.push({
      kind: 'replaceRelation',
      deleteRelationId: link.relationId,
      create: { typeId: link.typeId, fromEntityId: link.fromEntityId, toEntityId: canonical.id },
      note: `re-point inbound relation from duplicate ${member.id} to canonical ${canonical.id} (GRC-20 v2: relations are not re-pointable in place, so delete+create)`,
    });
  }
  ops.push({
    kind: 'deleteEntity',
    id: member.id,
    note: `delete duplicate of ${canonical.id} ("${canonical.name}")`,
  });
  return ops;
}

export interface BuildReportParams {
  space: string;
  mode: 'pre-publish' | 'scan';
  targets: NormalizedEntity[];
  drafts?: NormalizedEntity[] | undefined;
  config: DedupConfig;
  generateFixOps?: boolean;
}

export function buildReport(params: BuildReportParams): { report: DuplicateReport; matchResult: MatchResult } {
  const { space, mode, targets, drafts, config } = params;
  const generateFixOps = params.generateFixOps ?? true;
  const matchResult = match(targets, config, drafts);
  const inbound = buildInboundIndex(targets);

  const clusters: DuplicateCluster[] = [];
  let dupCount = 0;

  const inCluster = new Set<string>();
  for (const cluster of matchResult.clusters) {
    const { canonical, reason } = pickCanonical(cluster);
    const members: DuplicateClusterMember[] = [];
    const suggestedOps: PlanOp[] = [];

    for (const member of cluster) {
      inCluster.add(member.id);
      if (member.id === canonical.id) continue;
      const pair = matchResult.pairFor(member.id, canonical.id);
      // member may be linked to canonical transitively; fall back to best pair inside cluster
      const bestPair =
        pair ??
        matchResult.pairs
          .filter(p => p.a.id === member.id || p.b.id === member.id)
          .sort((x, y) => y.score - x.score)[0];
      const score = bestPair?.score ?? 0;
      dupCount++;

      members.push({
        id: member.id,
        name: member.name,
        isDraft: member.isDraft,
        score: Number(score.toFixed(3)),
        verdict: 'duplicate',
        signals: bestPair?.signals ?? [],
        source: member.source,
      });

      if (generateFixOps) {
        suggestedOps.push(...opsForDuplicate(member, canonical, inbound));
      }
    }

    clusters.push({
      canonical: { id: canonical.id, name: canonical.name, isDraft: canonical.isDraft, reason },
      duplicates: members.sort((a, b) => b.score - a.score),
      suggestedOps,
    });
  }

  clusters.sort((a, b) => (b.duplicates[0]?.score ?? 0) - (a.duplicates[0]?.score ?? 0));

  // likely pairs (outside the auto-merge band) for human review; weak pairs
  // are counted but not listed — on real data they are noise
  const weakCount = matchResult.pairs.filter(p => p.verdict === 'weak').length;
  const reviewPairs: ReviewPair[] = matchResult.pairs
    .filter(p => p.verdict === 'likely')
    .sort((x, y) => y.score - x.score)
    .slice(0, 300)
    .map(p => ({
      a: { id: p.a.id, name: p.a.name, isDraft: p.a.isDraft, source: p.a.source },
      b: { id: p.b.id, name: p.b.name, isDraft: p.b.isDraft, source: p.b.source },
      score: Number(p.score.toFixed(3)),
      verdict: p.verdict,
      signals: p.signals,
    }));
  const likelyCount = reviewPairs.length;

  const checked = (drafts?.length ?? 0) + (drafts ? 0 : targets.length);
  const report: DuplicateReport = {
    space,
    mode,
    generatedAt: new Date().toISOString(),
    thresholds: config.thresholds,
    clusters,
    reviewPairs,
    stats: {
      checked,
      clusters: clusters.length,
      duplicate: dupCount,
      likely: likelyCount,
      weak: weakCount,
    },
  };
  return { report, matchResult };
}

export function renderMarkdown(report: DuplicateReport): string {
  const lines: string[] = [];
  lines.push(`# Dedup report — space ${report.space} (${report.mode})`);
  lines.push('');
  lines.push(
    `Checked: ${report.stats.checked} · clusters: ${report.stats.clusters} · duplicate: ${report.stats.duplicate} · likely: ${report.stats.likely} · weak: ${report.stats.weak}`,
  );
  for (const c of report.clusters) {
    lines.push('');
    lines.push(`## Canonical: ${c.canonical.name} (${c.canonical.id}${c.canonical.isDraft ? ', draft' : ''})`);
    lines.push(`Reason: ${c.canonical.reason}`);
    for (const d of c.duplicates) {
      lines.push(
        `- [${d.verdict} ${d.score}] ${d.name} (${d.id}${d.isDraft ? ', draft' : ''}${d.source ? `, ${d.source}` : ''})`,
      );
      for (const s of d.signals) lines.push(`  - ${s.kind}: ${s.detail}`);
    }
    if (c.suggestedOps.length > 0) {
      lines.push(`  Fix plan: ${c.suggestedOps.map(o => o.kind).join(', ')}`);
    }
  }
  if (report.reviewPairs.length > 0) {
    lines.push('');
    lines.push(`## Review pairs (${report.reviewPairs.length}) — not auto-merged`);
    for (const p of report.reviewPairs) {
      lines.push(`- [${p.verdict} ${p.score}] ${p.a.name} <> ${p.b.name} | ${p.signals.map(s => s.kind).join(',')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
