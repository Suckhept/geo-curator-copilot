import { Encoding, Graph, Ipfs, getSmartAccountWalletClient, type Op } from '@graphprotocol/grc-20';
import {
  createRelation as grcCreateRelation,
  deleteEntity as grcDeleteEntity,
  deleteRelation as grcDeleteRelation,
  parseId,
  randomId,
} from '@geoprotocol/grc-20';
import type { PlanOp } from '@geo-copilot/core';

/**
 * Production Geo data contains 32-hex ids that are NOT RFC-4122 v4 (e.g.
 * variant nibble "7", observed on real Crypto-datasets entities). The
 * grc-20-ts wrapper's Id() validation rejects those, but the low-level
 * @geoprotocol/grc-20 parseId accepts any 16-byte hex/uuid. We try the
 * wrapper first (nicer ergonomics) and fall back to low-level op builders.
 */
type GrcId = Parameters<typeof grcDeleteEntity>[0];

function lenientId(id: string, hint: string): GrcId {
  const parsed = parseId(id);
  if (!parsed) throw new Error(`Invalid Geo id for ${hint}: "${id}"`);
  return parsed as unknown as GrcId;
}

export type Network = 'MAINNET' | 'TESTNET' | 'TESTNET_V2' | 'TESTNET_V3';

/**
 * Turns backend-agnostic PlanOps into real GRC-20 ops.
 *
 * - skipDraft / useCanonicalId are advisory (they change what the curator
 *   publishes, not the graph) and produce no ops.
 * - replaceRelation = deleteRelation + createRelation, because GRC-20 v2
 *   UpdateRelation can only unset spaces/versions/position, not re-point
 *   `toEntity` (verified against @geoprotocol/grc-20 types/op.d.ts).
 */
export function serializePlanOps(planOps: readonly PlanOp[]): { ops: Op[]; skipped: PlanOp[] } {
  const ops: Op[] = [];
  const skipped: PlanOp[] = [];
  for (const planOp of planOps) {
    switch (planOp.kind) {
      case 'deleteEntity': {
        try {
          ops.push(...Graph.deleteEntity({ id: planOp.id }).ops);
        } catch {
          ops.push(grcDeleteEntity(lenientId(planOp.id, 'deleteEntity')) as Op);
        }
        break;
      }
      case 'replaceRelation': {
        if (planOp.deleteRelationId !== undefined) {
          try {
            ops.push(...Graph.deleteRelation({ id: planOp.deleteRelationId }).ops);
          } catch {
            ops.push(grcDeleteRelation(lenientId(planOp.deleteRelationId, 'deleteRelation')) as Op);
          }
        }
        try {
          ops.push(
            ...Graph.createRelation({
              fromEntity: planOp.create.fromEntityId,
              toEntity: planOp.create.toEntityId,
              type: planOp.create.typeId,
            }).ops,
          );
        } catch {
          ops.push(
            grcCreateRelation({
              id: randomId(),
              entity: randomId(),
              from: lenientId(planOp.create.fromEntityId, 'replaceRelation.from'),
              to: lenientId(planOp.create.toEntityId, 'replaceRelation.to'),
              relationType: lenientId(planOp.create.typeId, 'replaceRelation.type'),
            }) as Op,
          );
        }
        break;
      }
      case 'skipDraft':
      case 'useCanonicalId': {
        skipped.push(planOp);
        break;
      }
    }
  }
  return { ops, skipped };
}

/**
 * Chain RPCs from grc-20-ts smart-wallet defaults. getSmartAccountWalletClient
 * itself ALWAYS defaults to the mainnet RPC, so for any TESTNET* network we
 * must pass the testnet RPC explicitly or the tx lands on the wrong chain.
 */
const MAINNET_RPC = 'https://rpc-geo-genesis-h0q2s21xx8.t.conduit.xyz';
const TESTNET_RPC = 'https://rpc-geo-test-zc16z3tcvf.t.conduit.xyz';

function rpcFor(network: Network): string {
  return network === 'MAINNET' ? MAINNET_RPC : TESTNET_RPC;
}

export interface PublishParams {
  spaceId: string;
  editName: string;
  ops: Op[];
  /** 0x private key; never logged, never persisted. Get via geobrowser.io/export-wallet */
  privateKey: `0x${string}`;
  network?: Network;
  /** Override the chain RPC (defaults follow `network`). */
  rpcUrl?: string | undefined;
  /** Dry run: upload to IPFS and fetch calldata but do not send the tx. */
  dryRun?: boolean;
}

export interface PublishResult {
  cid: string;
  editId: string;
  to?: `0x${string}` | undefined;
  txHash?: string | undefined;
  dryRun: boolean;
}

/**
 * Full ERC-flow: ops -> IPFS (binary edit) -> calldata from
 * POST {origin}/space/{spaceId}/edit/calldata -> tx via the Geo smart
 * account (gas sponsored during early access).
 */
export async function publishEdit(params: PublishParams): Promise<PublishResult> {
  const { spaceId, editName, ops, privateKey, network = 'MAINNET', dryRun = false } = params;

  const smartAccountWalletClient = await getSmartAccountWalletClient({
    privateKey,
    rpcUrl: params.rpcUrl ?? rpcFor(network),
  });
  const author = smartAccountWalletClient.account?.address;
  if (!author) throw new Error('Could not derive author address from the smart account wallet client');

  const { cid, editId } = await Ipfs.publishEdit({ name: editName, ops, author, network });

  const { to, data } = await Encoding.getEditCalldata({ spaceId, cid, network });

  if (dryRun) {
    return { cid, editId, to, dryRun: true };
  }

  const txHash = await smartAccountWalletClient.sendTransaction({
    to,
    value: 0n,
    data,
  } as Parameters<typeof smartAccountWalletClient.sendTransaction>[0]);

  return { cid, editId, to, txHash, dryRun: false };
}
