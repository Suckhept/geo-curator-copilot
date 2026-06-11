import { Encoding, Ipfs, getSmartAccountWalletClient, type Op as LegacyOp } from '@graphprotocol/grc-20';
import { createSmartAccountClient } from 'permissionless';
import { toSafeSmartAccount } from 'permissionless/accounts';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  pad,
  zeroHash,
} from 'viem';
import { entryPoint07Address } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createEdit,
  createRelation as grcCreateRelation,
  decodeEdit,
  deleteEntity as grcDeleteEntity,
  deleteRelation as grcDeleteRelation,
  encodeEdit,
  formatId,
  parseId,
  randomId,
  type Id,
  type Op,
} from '@geoprotocol/grc-20';
import type { PlanOp } from '@geo-copilot/core';

/**
 * Production Geo data contains 32-hex ids that are NOT RFC-4122 v4 (e.g.
 * variant nibble "7", observed on real Crypto-datasets entities).
 * @geoprotocol/grc-20 parseId accepts any 16-byte hex/uuid, so all ids go
 * through it.
 */
function geoId(id: string, hint: string): Id {
  const parsed = parseId(id);
  if (!parsed) throw new Error(`Invalid Geo id for ${hint}: "${id}"`);
  return parsed;
}

export type Network = 'MAINNET' | 'TESTNET' | 'TESTNET_V2' | 'TESTNET_V3';

/**
 * Turns backend-agnostic PlanOps into GRC-20 v2 ops (@geoprotocol/grc-20
 * 0.4.x — the wire format the TESTNET_V2 stack decodes; older builders from
 * @graphprotocol/grc-20 0.33 / @geoprotocol 0.1.x produce an ops encoding
 * that geobrowser rejects with "Encoding error").
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
        ops.push(grcDeleteEntity(geoId(planOp.id, 'deleteEntity')));
        break;
      }
      case 'deleteRelation': {
        ops.push(grcDeleteRelation(geoId(planOp.id, 'deleteRelation')));
        break;
      }
      case 'replaceRelation': {
        if (planOp.deleteRelationId !== undefined) {
          ops.push(grcDeleteRelation(geoId(planOp.deleteRelationId, 'deleteRelation')));
        }
        ops.push(
          grcCreateRelation({
            id: randomId(),
            entity: randomId(),
            from: geoId(planOp.create.fromEntityId, 'replaceRelation.from'),
            to: geoId(planOp.create.toEntityId, 'replaceRelation.to'),
            relationType: geoId(planOp.create.typeId, 'replaceRelation.type'),
          }),
        );
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

/**
 * TESTNET_V2 stack (chain 19411): the user's real Geo account is an
 * already-deployed Safe 1.4.1 (non-canonical masterCopy; its 4337 module
 * sits at the canonical EP-0.6 address but is compiled against EntryPoint
 * 0.7 — check SUPPORTED_ENTRYPOINT(), not the address). The SDK wrapper
 * can't address it (it
 * counterfactually derives a 1.4.1 address via canonical factories that only
 * exist on chain 80451), so we build the client via permissionless directly.
 * testnet-api has no /edit/calldata route either; calldata is built locally
 * as SpaceRegistry.enter(...).
 *
 * Edit publishing into a DAO space goes through governance: the enter()
 * carries a create-proposal action whose payload is
 * (bytes16 proposalId, uint256 proposalType, Action[]) with a single inner
 * DaoSpace.publish(0x0, abi.encode(cid), 0x) call. proposalType 0 = member
 * proposal (goes to editor vote); 1 = editor proposal (auto-executes) and is
 * rejected for non-editors (custom error 0x196f9913). Format decoded from
 * the user's own geobrowser-made txs (e.g.
 * 0x8fed599ca699625799dcc684eda3ee5d09f16864f9752b545172c514f6371349) and
 * verified by eth_call simulation from the same Safe.
 */
const SPACE_REGISTRY = '0xB01683b2f0d38d43fcD4D9aAB980166988924132' as const;
const CREATE_PROPOSAL_ACTION = '0xcf4356ed126c00d2e547ace2f69991a972d322b45371d61ce5478b1cb9acb4c2' as const;
const TESTNET_V2_API_ORIGIN = 'https://testnet-api.geobrowser.io';

/** POST the GRC2 binary to the Geo IPFS pinning route; returns ipfs://CID. */
async function uploadEditBinary(binary: Uint8Array): Promise<string> {
  const formData = new FormData();
  formData.append('file', new Blob([binary as unknown as ArrayBuffer]));
  const res = await fetch(`${TESTNET_V2_API_ORIGIN}/ipfs/upload-edit`, { method: 'POST', body: formData });
  if (!res.ok) throw new Error(`upload-edit failed: HTTP ${res.status} ${await res.text()}`);
  const { cid } = (await res.json()) as { cid: string };
  return cid.startsWith('ipfs://') ? cid : `ipfs://${cid}`;
}
/** Geo early-access gas sponsorship key, shipped publicly inside @graphprotocol/grc-20. */
const PIMLICO_BUNDLER_19411 = 'https://api.pimlico.io/v2/19411/rpc?apikey=pim_KqHm63txxhbCYjdDaWaHqH';

const GEO_TESTNET_CHAIN = {
  id: 19411,
  name: 'Geo Genesis Testnet',
  nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [TESTNET_RPC] },
    public: { http: [TESTNET_RPC] },
  },
} as const;

const SPACE_REGISTRY_ABI = [
  {
    name: 'enter',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'fromSpaceId', type: 'bytes16' },
      { name: 'toSpaceId', type: 'bytes16' },
      { name: 'action', type: 'bytes32' },
      { name: 'topic', type: 'bytes32' },
      { name: 'data', type: 'bytes' },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'addressToSpaceId',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [{ type: 'bytes16' }],
  },
  {
    name: 'spaceIdToAddress',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'spaceId', type: 'bytes16' }],
    outputs: [{ type: 'address' }],
  },
] as const;

const DAO_SPACE_PUBLISH_ABI = [
  {
    name: 'publish',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_topic', type: 'bytes32' },
      { name: '_editsContentUri', type: 'bytes' },
      { name: '_editsMetadata', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

const PROPOSAL_PAYLOAD_PARAMS = [
  { name: 'proposalId', type: 'bytes16' },
  { name: 'proposalType', type: 'uint256' },
  {
    name: 'actions',
    type: 'tuple[]',
    components: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
  },
] as const;

/** "5908c73a-d336-…" | "5908c73ad336…" -> 0x-prefixed bytes16. */
function spaceIdToBytes16(spaceId: string): `0x${string}` {
  const hex = spaceId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`Not a 16-byte space id: "${spaceId}"`);
  return `0x${hex}`;
}

/** Fresh proposal id, uuid-v4-shaped like the ones geobrowser generates. */
function randomProposalId(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return `0x${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
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
  /**
   * Address of an already-deployed Geo Safe on chain 19411 (env
   * GEO_SAFE_ADDRESS). When set, publish goes through that Safe via the
   * Pimlico bundler instead of the SDK's mainnet-only smart-account path.
   */
  safeAddress?: `0x${string}` | undefined;
  /** Dry run: upload to IPFS and fetch calldata but do not send the tx. */
  dryRun?: boolean;
}

export interface PublishResult {
  cid: string;
  editId: string;
  to?: `0x${string}` | undefined;
  from?: `0x${string}` | undefined;
  /** Governance proposal id (DAO spaces): track it in the space's governance tab. */
  proposalId?: `0x${string}` | undefined;
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

  if (params.safeAddress) {
    return publishEditViaSafe({ ...params, safeAddress: params.safeAddress });
  }

  const smartAccountWalletClient = await getSmartAccountWalletClient({
    privateKey,
    rpcUrl: params.rpcUrl ?? rpcFor(network),
  });
  const author = smartAccountWalletClient.account?.address;
  if (!author) throw new Error('Could not derive author address from the smart account wallet client');

  // Legacy MAINNET path, kept for completeness: the 0.33 SDK encodes its own
  // (older) wire format and our 0.4.x-shaped ops are structurally compatible
  // only by accident — re-verify before ever using this path for real.
  const { cid, editId } = await Ipfs.publishEdit({ name: editName, ops: ops as unknown as LegacyOp[], author, network });

  const { to, data } = await Encoding.getEditCalldata({ spaceId, cid, network });

  if (dryRun) {
    return { cid, editId, to, from: author, dryRun: true };
  }

  const txHash = await smartAccountWalletClient.sendTransaction({
    to,
    value: 0n,
    data,
  } as Parameters<typeof smartAccountWalletClient.sendTransaction>[0]);

  return { cid, editId, to, from: author, txHash, dryRun: false };
}

/**
 * Publish flow for the TESTNET_V2 stack: edit -> IPFS, then
 * SpaceRegistry.enter(personalSpace, targetSpace, EDITS_PUBLISHED, 0x0, cid)
 * sent from the user's existing Geo Safe (EntryPoint 0.6, Pimlico-sponsored).
 */
async function publishEditViaSafe(
  params: PublishParams & { safeAddress: `0x${string}` },
): Promise<PublishResult> {
  const { spaceId, editName, ops, privateKey, network = 'TESTNET_V2', safeAddress, dryRun = false } = params;

  const rpcUrl = params.rpcUrl ?? TESTNET_RPC;
  const publicClient = createPublicClient({ chain: GEO_TESTNET_CHAIN, transport: http(rpcUrl) });

  const safeAccount = await toSafeSmartAccount({
    client: publicClient,
    owners: [privateKeyToAccount(privateKey)],
    address: safeAddress,
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    version: '1.4.1',
  });

  const fromSpaceId = await publicClient.readContract({
    address: SPACE_REGISTRY,
    abi: SPACE_REGISTRY_ABI,
    functionName: 'addressToSpaceId',
    args: [safeAddress],
  });
  if (BigInt(fromSpaceId) === 0n) {
    throw new Error(`Safe ${safeAddress} has no personal space in SpaceRegistry on chain 19411`);
  }

  const toSpaceId = spaceIdToBytes16(spaceId);
  const spaceAddress = await publicClient.readContract({
    address: SPACE_REGISTRY,
    abi: SPACE_REGISTRY_ABI,
    functionName: 'spaceIdToAddress',
    args: [toSpaceId],
  });
  if (BigInt(spaceAddress) === 0n) {
    throw new Error(`Space ${spaceId} has no contract in SpaceRegistry on chain 19411`);
  }

  // GRC2 binary edit in the 0.4.x wire format that the TESTNET_V2 frontend
  // decodes (0.33 SDK's Ipfs.publishEdit emits the older 0.1.x ops encoding
  // -> "Encoding error" on the proposal page). Author = the PERSONAL SPACE id,
  // not an address (verified by decoding geobrowser-made edits).
  const editIdBytes = randomId();
  const edit = createEdit({
    id: editIdBytes,
    name: editName,
    author: geoId(fromSpaceId.slice(2), 'author'),
    createdAt: BigInt(Date.now()) * 1000n,
    ops,
  });
  const binary = encodeEdit(edit);
  decodeEdit(binary); // round-trip self-check before anything leaves the machine
  const cid = await uploadEditBinary(binary);
  const editId = formatId(editIdBytes);

  const proposalId = randomProposalId();
  const publishCall = encodeFunctionData({
    abi: DAO_SPACE_PUBLISH_ABI,
    functionName: 'publish',
    args: [zeroHash, encodeAbiParameters([{ type: 'string' }], [cid]), '0x'],
  });
  const payload = encodeAbiParameters(PROPOSAL_PAYLOAD_PARAMS, [
    proposalId,
    0n, // member proposal -> editor vote; 1 (editor-only) reverts for members
    [{ to: spaceAddress, value: 0n, data: publishCall }],
  ]);
  const data = encodeFunctionData({
    abi: SPACE_REGISTRY_ABI,
    functionName: 'enter',
    args: [fromSpaceId, toSpaceId, CREATE_PROPOSAL_ACTION, pad(proposalId, { size: 32, dir: 'right' }), payload, '0x'],
  });

  // The registry authorizes msg.sender (the Safe), so this simulation proves
  // the real call would not revert — for dry runs and as a pre-flight check.
  await publicClient.call({ account: safeAddress, to: SPACE_REGISTRY, data });

  if (dryRun) {
    return { cid, editId, to: SPACE_REGISTRY, from: safeAddress, proposalId, dryRun: true };
  }

  const bundlerTransport = http(PIMLICO_BUNDLER_19411);
  const paymasterClient = createPimlicoClient({
    transport: bundlerTransport,
    chain: GEO_TESTNET_CHAIN,
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });
  const smartAccountClient = createSmartAccountClient({
    chain: GEO_TESTNET_CHAIN,
    account: safeAccount,
    paymaster: paymasterClient,
    bundlerTransport,
    userOperation: {
      estimateFeesPerGas: async () => (await paymasterClient.getUserOperationGasPrice()).fast,
    },
  });

  const txHash = await smartAccountClient.sendTransaction({
    to: SPACE_REGISTRY,
    value: 0n,
    data,
  } as Parameters<typeof smartAccountClient.sendTransaction>[0]);

  return { cid, editId, to: SPACE_REGISTRY, from: safeAddress, proposalId, txHash, dryRun: false };
}
