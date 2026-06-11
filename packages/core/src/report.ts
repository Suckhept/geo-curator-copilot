import type {
  DedupConfig,
  DuplicateCluster,
  DuplicateClusterMember,
  DuplicateReport,
  IntraEntityIssue,
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

/**
 * Schema entities — ids that other entities reference as a value property,
 * relation type, or entity type. Property/type definitions legitimately share
 * names ("Date", "Source", …), and deleting one silently breaks every entity
 * that uses it, so they are never auto-merged: any cluster pair touching a
 * schema entity is demoted to review with a `schema.entity` signal.
 */
export function collectSchemaIds(targets: readonly NormalizedEntity[]): Set<string> {
  const ids = new Set<string>();
  for (const t of targets) {
    for (const typeId of t.typeIds) ids.add(typeId);
    for (const v of t.values) ids.add(v.propertyId);
    for (const r of t.relations) ids.add(r.typeId);
  }
  return ids;
}

/**
 * Curator lint: duplicate relations/values INSIDE one entity. Relations with
 * the same (typeId, toEntityId) are real graph duplicates — every copy after
 * the first gets a deleteRelation op. Values with the same (propertyId,
 * value) are advisory only: snapshot values carry no ids to delete by.
 */
export function findIntraEntityDuplicates(targets: readonly NormalizedEntity[]): IntraEntityIssue[] {
  const issues: IntraEntityIssue[] = [];
  for (const e of targets) {
    if (e.isDraft) continue;

    const relGroups = new Map<string, NormalizedEntity['relations']>();
    for (const r of e.relations) {
      const k = `${r.typeId} -> ${r.toEntityId}`;
      const list = relGroups.get(k);
      if (list) list.push(r);
      else relGroups.set(k, [r]);
    }
    for (const [key, group] of relGroups) {
      if (group.length < 2) continue;
      const [keep, ...extras] = group;
      const planOps: PlanOp[] = extras
        .filter(r => r.id !== undefined)
        .map(r => ({
          kind: 'deleteRelation' as const,
          id: r.id!,
          note: `duplicate relation ${key} on "${e.name}" (${e.id}) — keeping ${keep!.id ?? 'first copy'}`,
        }));
      issues.push({ entityId: e.id, entityName: e.name, kind: 'relation', key, count: group.length, planOps });
    }

    const valGroups = new Map<string, number>();
    for (const v of e.values) {
      const value = v.text ?? v.datetime ?? (v.boolean !== undefined ? String(v.boolean) : v.float !== undefined ? String(v.float) : '');
      const k = `${v.propertyId} = ${value}`;
      valGroups.set(k, (valGroups.get(k) ?? 0) + 1);
    }
    for (const [key, count] of valGroups) {
      if (count < 2) continue;
      issues.push({ entityId: e.id, entityName: e.name, kind: 'value', key, count, planOps: [] });
    }
  }
  return issues;
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
  const schemaIds = collectSchemaIds(targets);

  const clusters: DuplicateCluster[] = [];
  const schemaReviewPairs: ReviewPair[] = [];
  let dupCount = 0;

  const inCluster = new Set<string>();
  for (const cluster of matchResult.clusters) {
    const { canonical, reason } = pickCanonical(cluster);
    const members: DuplicateClusterMember[] = [];
    const suggestedOps: PlanOp[] = [];
    const canonicalIsSchema = schemaIds.has(canonical.id);

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

      // Schema guard: pairs touching property/type definitions are demoted to
      // review — same names are by design there, deletion breaks consumers.
      if (canonicalIsSchema || schemaIds.has(member.id)) {
        const which = [
          ...(schemaIds.has(member.id) ? [member.id] : []),
          ...(canonicalIsSchema ? [canonical.id] : []),
        ].join(', ');
        schemaReviewPairs.push({
          a: { id: member.id, name: member.name, isDraft: member.isDraft, source: member.source },
          b: { id: canonical.id, name: canonical.name, isDraft: canonical.isDraft },
          score: Number(score.toFixed(3)),
          verdict: 'likely',
          signals: [
            ...(bestPair?.signals ?? []),
            { kind: 'schema.entity', score: 0, detail: `used as property/type by other entities: ${which}` },
          ],
        });
        continue;
      }
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

    if (members.length === 0) continue;
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
  const reviewPairs: ReviewPair[] = [
    ...schemaReviewPairs,
    ...matchResult.pairs
      .filter(p => p.verdict === 'likely')
      .map(p => ({
        a: { id: p.a.id, name: p.a.name, isDraft: p.a.isDraft, source: p.a.source },
        b: { id: p.b.id, name: p.b.name, isDraft: p.b.isDraft, source: p.b.source },
        score: Number(p.score.toFixed(3)),
        verdict: p.verdict,
        signals: p.signals,
      })),
  ]
    .sort((x, y) => y.score - x.score)
    .slice(0, 300);
  const likelyCount = reviewPairs.length;

  const checked = (drafts?.length ?? 0) + (drafts ? 0 : targets.length);
  const intraEntity = findIntraEntityDuplicates(targets);
  const report: DuplicateReport = {
    space,
    mode,
    generatedAt: new Date().toISOString(),
    thresholds: config.thresholds,
    clusters,
    reviewPairs,
    intraEntity,
    stats: {
      checked,
      clusters: clusters.length,
      duplicate: dupCount,
      likely: likelyCount,
      weak: weakCount,
      intraRelationDuplicates: intraEntity.filter(i => i.kind === 'relation').length,
      intraValueDuplicates: intraEntity.filter(i => i.kind === 'value').length,
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
  if (report.intraEntity.length > 0) {
    lines.push('');
    lines.push(`## Duplicate relations within entities (${report.intraEntity.length})`);
    for (const i of report.intraEntity) {
      lines.push(
        `- [${i.kind} x${i.count}] ${i.entityName} (${i.entityId}): ${i.key}` +
          (i.planOps.length > 0 ? ` — fix: ${i.planOps.length} deleteRelation` : ' — advisory'),
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
