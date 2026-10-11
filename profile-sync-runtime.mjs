import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDefaultDriveClient } from './drive-runtime.mjs';
import { observeWorkModelDiscovery } from './profile-discovery.mjs';
import { WorkCatalogSource } from './profile-work-source.mjs';
import { NormalChatCatalogSource } from './profile-chat-source.mjs';
import {
  GoogleDocsRegistryStore,
  LocalProfileSyncStateStore,
  ProfileRegistrySynchronizer,
} from './profile-registry-sync.mjs';
import {
  HttpTrackedSource,
  parseCodexModelDiscovery,
} from './profile-upstreams.mjs';

const SCHEMA = 'selfrun-profile-sync-runtime-v1';
const CHAT_SOURCE =
  'https://raw.githubusercontent.com/SyntaxSmith/rosetta/main/README.md';
const WORK_CATALOG_SOURCE =
  'https://raw.githubusercontent.com/gaoren002/GPT2Image-Pro/main/docs/memory/2026-09-09-har-model-catalog.md';
const WORK_ACTIVATION_SOURCE =
  'https://raw.githubusercontent.com/youdie006/prodex/main/CHANGELOG.md';
const WORK_DISCOVERY_SOURCE =
  'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json';
function defaultConfig() {
  return {
    schema: SCHEMA,
    enabled: false,
    dry_run: true,
    registries: {},
    sources: {
      chat_url: CHAT_SOURCE,
      work_catalog_url: WORK_CATALOG_SOURCE,
      work_activation_url: WORK_ACTIVATION_SOURCE,
      work_discovery_url: WORK_DISCOVERY_SOURCE,
    },
  };
}

export async function loadProfileSyncRuntimeConfig(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultConfig();
    throw error;
  }
}
export function validateProfileSyncRuntimeConfig(config) {
  const reasons = [];
  if (!config || config.schema !== SCHEMA) reasons.push('INVALID_SCHEMA');
  if (typeof config?.enabled !== 'boolean') reasons.push('ENABLED_BOOLEAN_REQUIRED');
  if (typeof config?.dry_run !== 'boolean') reasons.push('DRY_RUN_BOOLEAN_REQUIRED');
  if (config?.enabled === true) {
    for (const mode of ['CHAT', 'WORK']) {
      if (!String(config?.registries?.[mode]?.document_id || '')) {
        reasons.push(mode + '_DOCUMENT_ID_REQUIRED');
      }
    }
  }
  const supplement = config?.sources?.work_verified_snapshot_file;
  if (supplement !== undefined && (typeof supplement !== 'string' || !path.isAbsolute(supplement))) {
    reasons.push('WORK_VERIFIED_SNAPSHOT_ABSOLUTE_PATH_REQUIRED');
  }
  return { ok: reasons.length === 0, reasons };
}

function safeError(error) {
  return String(error?.message || error || 'UNKNOWN').slice(0, 800);
}
function makeSources(config, fetchImpl = fetch, collectChat, chatCanWrite, isActive, deadline, ownershipJournal, reservationOwner, collectWork, workCanWrite) {
  const sourceConfig = { ...defaultConfig().sources, ...(config.sources || {}) };
  return {
    CHAT: new NormalChatCatalogSource({ collect: collectChat, canWrite: chatCanWrite, isActive, deadline, ownershipJournal, reservationOwner }),
    WORK: new WorkCatalogSource({collect:collectWork,canWrite:workCanWrite||chatCanWrite,isActive,deadline,ownershipJournal,reservationOwner}),
    DISCOVERY: new HttpTrackedSource({
      url: sourceConfig.work_discovery_url,
      parser: parseCodexModelDiscovery,
      fetchImpl: (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) }),
    }),
  };
}

export async function runProfileSyncOnce(options = {}) {
  const home = options.home || os.homedir();
  const configFile = options.configFile
    || process.env.PROFILE_SYNC_RUNTIME_CONFIG
    || path.join(home, '.profile-sync', 'runtime.json');
  const config = options.config || await loadProfileSyncRuntimeConfig(configFile);
  const validation = validateProfileSyncRuntimeConfig(config);
  if (!validation.ok) {
    return { schema: SCHEMA, status: 'CONFIG_REJECTED', reasons: validation.reasons };
  }
  if (!config.enabled) {
    return { schema: SCHEMA, status: 'DISABLED', mutation_enabled: false };
  }

  const isActive = typeof options.isActive === 'function'
    ? options.isActive
    : async () => options.active === true;
  const active = await isActive();
  const dryRun = options.dryRun ?? config.dry_run;
  const drive = options.drive || createDefaultDriveClient({ home });
  const store = options.store || new GoogleDocsRegistryStore(drive);
  const stateRoot = options.stateRoot || path.join(home, '.profile-sync', 'state');
  const stateStore = options.stateStore || new LocalProfileSyncStateStore(stateRoot);
  const sources = options.sources || makeSources(config, options.fetchImpl || fetch, options.collectChat, options.chatCanWrite, isActive, options.collectorDeadline, options.collectorOwnershipJournal, options.reservationOwner, options.collectWork, options.workCanWrite);
  const results = {};
  for (const mode of ['CHAT', 'WORK']) {
    if(mode==='WORK'&&sources.CHAT?.cleanupVerified===false){results.WORK={status:'COLLECTION_BLOCKED_PRIOR_CLEANUP_UNVERIFIED'};continue;}
    const sync = new ProfileRegistrySynchronizer({
      mode,
      documentId: config.registries[mode].document_id,
      source: sources[mode],
      store,
      stateStore,
      isActive: async () => await isActive() && (typeof sources[mode]?.canWrite !== 'function' || await sources[mode].canWrite()),
      dryRun,
      requireWriteRevision: options.requireWriteRevision === true,
      minimumRetentionRatio: Number(config.minimum_retention_ratio || 0.5),
    });
    try {
      results[mode] = await sync.run();
      if (sources[mode]?.catalogMetadata) {
        results[mode].catalog_metadata = sources[mode].catalogMetadata;
      }
    } catch (error) {
      results[mode] = { status: 'ERROR', error: safeError(error) };
    }
  }

  results.WORK.discovery = sources.DISCOVERY ? await observeWorkModelDiscovery({
    source: sources.DISCOVERY,
    cacheFile: path.join(stateRoot, 'work-discovery.json'),
    store,
    documentId: config.registries.WORK.document_id,
    isActive,
    dryRun,
    now: options.now,
  }) : { status: 'NOT_CONFIGURED', work_request_mapping: 'UNVERIFIED' };

  return {
    schema: SCHEMA,
    status: active ? (['CHAT','WORK'].some(mode=>results[mode]?.status==='CURRENT_SELECTABLE_ZERO_BLOCKED')?'CATALOG_PUBLICATION_BLOCKED':'COMPLETED') : 'STANDBY_NOOP',
    active,
    dry_run: dryRun,
    mutation_enabled: active && !dryRun,
    collection_cleanup_verified: sources.CHAT?.cleanupVerified !== false && sources.WORK?.cleanupVerified !== false,
    completed_at: new Date().toISOString(),
    results,
  };
}
