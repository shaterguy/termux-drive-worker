import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateSnapshot } from './profile-registry-sync.mjs';

const SCHEMA = 'selfrun-verified-work-profiles-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = (base, supplement) => base
  ? 'work-verified:' + hash(JSON.stringify([base, supplement]))
  : null;
const signalKey = profile => profile.signal.model.trim().toLowerCase()
  + '\0' + profile.signal.reasoning.trim().toLowerCase();

// Only this separately reviewed source is retained across upstream replacements.
// Current registry contents are never used as another source.
export class VerifiedWorkSource {
  constructor({ source, file }) {
    this.source = source;
    this.file = file;
  }

  async readSupplement() {
    const stat = await fs.stat(this.file);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error('VERIFIED_WORK_FILE_INVALID');
    }
    const raw = await fs.readFile(this.file, 'utf8');
    const value = JSON.parse(raw);
    if (value?.schema !== SCHEMA
        || !value.evidence || typeof value.evidence !== 'object'
        || Array.isArray(value.evidence)
        || typeof value.evidence.kind !== 'string' || !value.evidence.kind) {
      throw new Error('VERIFIED_WORK_SNAPSHOT_INVALID');
    }
    const checked = validateSnapshot('WORK', value.profiles);
    if (!checked.ok) {
      throw new Error('VERIFIED_WORK_PROFILES_INVALID:' + checked.reasons.join(','));
    }
    return { hash: hash(raw), profiles: value.profiles };
  }

  async probe() {
    const supplement = await this.readSupplement();
    const base = await this.source.probe();
    const checked = await this.readSupplement();
    if (checked.hash !== supplement.hash) {
      throw new Error('VERIFIED_WORK_CHANGED_DURING_PROBE');
    }
    return {
      identity: identity(base?.identity, supplement.hash),
      base,
      supplementHash: supplement.hash,
    };
  }

  async fetch(probed = null) {
    const observed = probed || await this.probe();
    const supplement = await this.readSupplement();
    if (supplement.hash !== observed.supplementHash) {
      throw new Error('VERIFIED_WORK_CHANGED_DURING_PROBE');
    }
    const upstream = await this.source.fetch(observed.base);
    const baseValidation = validateSnapshot('WORK', upstream?.profiles);
    if (!baseValidation.ok) {
      throw new Error('BASE_WORK_PROFILES_INVALID:' + baseValidation.reasons.join(','));
    }
    const profiles = [...upstream.profiles];
    const bySignal = new Map(profiles.map(profile => [signalKey(profile), profile]));
    for (const profile of supplement.profiles) {
      const key = signalKey(profile);
      const existing = bySignal.get(key);
      if (existing) {
        if (existing.fingerprint !== profile.fingerprint) {
          throw new Error('VERIFIED_WORK_SIGNAL_CONFLICT:'
            + profile.signal.model + '/' + profile.signal.reasoning);
        }
        continue;
      }
      bySignal.set(key, profile);
      profiles.push(profile);
    }
    const validation = validateSnapshot('WORK', profiles);
    if (!validation.ok) {
      throw new Error('COMBINED_WORK_PROFILES_INVALID:' + validation.reasons.join(','));
    }
    return {
      ...upstream,
      profiles,
      identity: identity(upstream.identity || observed.base?.identity, supplement.hash),
    };
  }
}
