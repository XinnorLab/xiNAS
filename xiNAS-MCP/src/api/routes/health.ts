import { Router } from 'express';
import { sendOk } from '../handlers/reads.js';
import { listByPrefix, getOrNull } from '../handlers/reads.js';
import { ApiException } from '../errors.js';
import type { ApiContext } from '../context.js';

// Per api-v1.yaml: { type: string, enum: [quick, standard, deep], default: quick }
const ALLOWED_PROFILES = new Set(['quick', 'standard', 'deep']);

/** api-v1 HealthCheck.status values, worst-first for the overall fold. */
const SEVERITY = ['critical', 'degraded', 'warning', 'ok'] as const;
type CheckStatus = (typeof SEVERITY)[number] | 'skipped';

interface HealthCheck {
  id: string;
  category: string;
  status: CheckStatus;
  symptom: string;
  impact: string;
  evidence: Record<string, unknown>;
  recommended_action: string;
}

/**
 * network.duplicate-netplan (S6 T9, ADR-0008): CRITICAL when any managed
 * interface is defined in a foreign netplan file — netplan would merge
 * the stanzas (phantom IPs, conflicting PBR). KV-derived (the
 * NetworkConfig/default singleton); no agent round-trip.
 */
function duplicateNetplanCheck(ctx: ApiContext): HealthCheck {
  const config = getOrNull<{ status?: { duplicates?: Record<string, string[]> } }>(
    ctx.state,
    '/xinas/v1/observed/NetworkConfig/default',
  );
  const duplicates = config?.value.status?.duplicates ?? {};
  const names = Object.keys(duplicates);
  if (config === null) {
    return {
      id: 'network.duplicate-netplan',
      category: 'network',
      status: 'skipped',
      symptom: 'no netplan observation yet (agent boot pending)',
      impact: 'unknown',
      evidence: {},
      recommended_action: 'wait for the first agent observation sweep',
    };
  }
  if (names.length === 0) {
    return {
      id: 'network.duplicate-netplan',
      category: 'network',
      status: 'ok',
      symptom: 'every managed interface is defined only in 99-xinas.yaml',
      impact: 'none',
      evidence: {},
      recommended_action: 'no action required',
    };
  }
  return {
    id: 'network.duplicate-netplan',
    category: 'network',
    status: 'critical',
    symptom: `managed interface(s) ${names.join(', ')} are also defined in foreign netplan files`,
    impact:
      'netplan merges duplicate stanzas: phantom IPs and conflicting PBR rules survive applies',
    evidence: { duplicates },
    recommended_action:
      "re-plan the next network change with cleanup: true (the audited repair), or remove the foreign stanzas manually",
  };
}

/**
 * network.rdma-readiness (S6 T9): per managed interface — rdma-capable ∧
 * rdma link up ∧ has an address ⇒ ready. This is the evidence the later
 * NFS-RDMA enable gate consumes; it blocks nothing here.
 */
function rdmaReadinessCheck(ctx: ApiContext): HealthCheck {
  const rows = listByPrefix<{
    id?: string;
    status?: {
      rdma_capable?: boolean;
      rdma_link_state?: string;
      current_addresses?: string[];
    };
  }>(ctx.state, '/xinas/v1/observed/NetworkInterface/');
  const managed = rows
    .map((r) => r.value)
    .filter((v) => v.status?.rdma_capable === true);
  if (managed.length === 0) {
    return {
      id: 'network.rdma-readiness',
      category: 'network',
      status: 'skipped',
      symptom: 'no RDMA-capable interfaces observed',
      impact: 'NFS-RDMA unavailable on this node',
      evidence: {},
      recommended_action: 'no action required (no mlx interfaces)',
    };
  }
  const perIface = managed.map((v) => ({
    name: v.id ?? 'unknown',
    rdma_link_state: v.status?.rdma_link_state ?? 'unknown',
    has_address: (v.status?.current_addresses ?? []).length > 0,
  }));
  const notReady = perIface.filter((e) => e.rdma_link_state !== 'up' || !e.has_address);
  if (notReady.length === 0) {
    return {
      id: 'network.rdma-readiness',
      category: 'network',
      status: 'ok',
      symptom: `${perIface.length} RDMA interface(s) up and addressed`,
      impact: 'none',
      evidence: { interfaces: perIface },
      recommended_action: 'no action required',
    };
  }
  return {
    id: 'network.rdma-readiness',
    category: 'network',
    status: 'degraded',
    symptom: `${notReady.length} of ${perIface.length} RDMA interface(s) not ready: ${notReady
      .map((e) => e.name)
      .join(', ')}`,
    impact: 'NFS-RDMA mounts via the unready interfaces will fail or fall back to TCP',
    evidence: { interfaces: perIface },
    recommended_action:
      'check rdma link state (cabling/MOFED) and interface addressing (PATCH /network/interfaces/{id})',
  };
}

/** Fold check statuses into the overall (skipped ignored; worst wins). */
function overallOf(checks: HealthCheck[]): string {
  for (const level of SEVERITY) {
    if (checks.some((c) => c.status === level)) return level;
  }
  return 'ok';
}

export function healthRouter(ctx: ApiContext): Router {
  const r = Router();

  r.get('/health', (req, res) => {
    const profile = (req.query.profile as string | undefined) ?? 'quick';
    if (!ALLOWED_PROFILES.has(profile)) {
      throw new ApiException(
        'INVALID_ARGUMENT',
        `unknown health profile '${profile}'; must be one of: quick, standard, deep`,
        { profile },
      );
    }
    const now = new Date().toISOString();
    const checks: HealthCheck[] = [
      {
        id: 'xinas-api.alive',
        category: 'api',
        status: 'ok',
        symptom: 'xinas-api is responding',
        impact: 'none',
        evidence: {},
        recommended_action: 'no action required',
      },
      // S6 T9 — the first real KV-derived checks (quick profile: no agent
      // round-trip; the observed projections are the evidence).
      duplicateNetplanCheck(ctx),
      rdmaReadinessCheck(ctx),
    ];
    sendOk(req, res, {
      profile,
      started_at: now,
      completed_at: now,
      overall: overallOf(checks),
      checks,
    });
  });

  return r;
}
