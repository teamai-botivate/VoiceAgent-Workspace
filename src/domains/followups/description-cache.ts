import type { FollowupContext } from './repository.js';
import { spokenRequirement, spokenSpecification } from './speech.js';

type Descriptions = {
  spokenRequirementNumber: string;
  items: Array<{ id: string; name: string; specification: string; spokenSpecification: string }>;
};

/** Only derived descriptions are cached. Every invocation receives fresh DB context.
 * Quantities, consent, policies, versions, rates and commit decisions are never cached.
 */
export class CallDescriptionCache {
  private readonly entries = new Map<
    string,
    { fingerprint: string; expiresAt: number; value: Descriptions }
  >();
  constructor(
    private readonly maxEntries = 128,
    private readonly ttlMs = 600_000,
    private readonly now = Date.now,
  ) {}

  get(context: FollowupContext, callSessionId: string): Descriptions {
    const time = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= time) this.entries.delete(key);
    const key = JSON.stringify([context.tenantId, context.followupId, callSessionId]);
    const fingerprint = JSON.stringify([
      context.requirementId,
      context.requirementVersion,
      context.requirementNumber,
      context.items.map(({ id, name, specification }) => [id, name, specification]),
    ]);
    const entry = this.entries.get(key);
    if (entry?.fingerprint === fingerprint) return structuredClone(entry.value);
    const value = {
      spokenRequirementNumber: spokenRequirement(context.requirementNumber),
      items: context.items.map(({ id, name, specification }) => ({
        id,
        name,
        specification,
        spokenSpecification: spokenSpecification(specification),
      })),
    };
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { fingerprint, expiresAt: time + this.ttlMs, value });
    return structuredClone(value);
  }

  get size(): number {
    return this.entries.size;
  }
  clear(): void {
    this.entries.clear();
  }
}
