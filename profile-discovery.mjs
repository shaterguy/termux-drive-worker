import { atomicWriteJson, readJsonStrict } from './util.mjs';
import { validateRegistry } from './profile-registry-sync.mjs';
import { normalizeCodexModelDiscoveries } from './profile-upstreams.mjs';

const CACHE_SCHEMA = 'selfrun-codex-model-discovery-v1';
const safeError = (error) => String(error?.message || error || 'UNKNOWN').slice(0, 500);

async function readCache(file, sourceUrl) {
  const result = await readJsonStrict(file);
  if (result.kind === 'MISSING') return null;
  if (!result.ok) throw new Error('DISCOVERY_CACHE_READ_FAILED:' + result.kind);
  const value = result.value;
  if (value?.source_url !== sourceUrl) return null;
  if (value?.schema !== CACHE_SCHEMA
      || typeof value.source_identity !== 'string' || !value.source_identity
      || value.source_identity.length > 1024
      || !Number.isFinite(Date.parse(value.last_success_at))
      || !Number.isFinite(Date.parse(value.last_fetched_at))) {
    throw new Error('DISCOVERY_CACHE_INVALID');
  }
  return {
    schema: CACHE_SCHEMA,
    source_url: sourceUrl,
    source_identity: value.source_identity,
    last_success_at: value.last_success_at,
    last_fetched_at: value.last_fetched_at,
    models: normalizeCodexModelDiscoveries(value.models),
  };
}

export async function observeWorkModelDiscovery({
  source, cacheFile, store, documentId, isActive, dryRun,
  now = () => new Date().toISOString(),
}) {
  if (!(await isActive())) return { status: 'STANDBY_NOOP' };
  const checkedAt = now();
  let snapshot = null;
  let cacheError = null;
  try {
    snapshot = await readCache(cacheFile, source.url);
  } catch (error) {
    cacheError = safeError(error);
  }
  let sourceError = null;
  try {
    const probed = await source.probe();
    if (!snapshot || !probed?.identity || probed.identity !== snapshot.source_identity) {
      const observed = await source.fetch(probed);
      snapshot = {
        schema: CACHE_SCHEMA,
        source_url: source.url,
        source_identity: observed.identity,
        models: normalizeCodexModelDiscoveries(observed.models),
        last_fetched_at: checkedAt,
      };
    }
    snapshot = { ...snapshot, last_success_at: checkedAt };
  } catch (error) {
    sourceError = safeError(error);
  }

  // This cache is separate from both active registry documents and sync state.
  if (!sourceError && !dryRun && await isActive()) {
    try {
      await atomicWriteJson(cacheFile, snapshot);
    } catch (error) {
      cacheError = safeError(error);
    }
  }

  let missing = null;
  let registryError = null;
  if (snapshot?.models?.length) {
    try {
      const current = (await store.read(documentId)).value;
      const validation = validateRegistry('WORK', current);
      if (!validation.ok) throw new Error('DISCOVERY_REGISTRY_INVALID:' + validation.reasons.join(','));
      // Compare names using only existing Work slugs. Never generate a new -wm slug.
      const activeNames = new Set(current.profiles.map((profile) => profile.request.model.replace(/-wm$/, '')));
      missing = snapshot.models.map((model) => model.slug).filter((slug) => !activeNames.has(slug));
    } catch (error) {
      registryError = safeError(error);
    }
  }

  return {
    status: 'DISCOVERY_ONLY',
    source_url: source.url,
    source_identity: snapshot?.source_identity ?? null,
    checked_at: checkedAt,
    last_success_at: snapshot?.last_success_at ?? null,
    last_fetched_at: snapshot?.last_fetched_at ?? null,
    source_status: sourceError ? 'UNAVAILABLE' : 'FRESH',
    stale: !!sourceError,
    models: snapshot?.models ?? [],
    work_request_mapping: 'UNVERIFIED',
    coverage_status: missing === null ? 'UNKNOWN' : missing.length ? 'MISSING_ACTIVE_MODELS' : 'MODEL_NAMES_PRESENT',
    missing_active_models: missing,
    ...(sourceError ? { error: sourceError } : {}),
    ...(cacheError ? { cache_error: cacheError } : {}),
    ...(registryError ? { registry_error: registryError } : {}),
  };
}
