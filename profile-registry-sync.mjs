import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJson, readJsonStrict } from './util.mjs';
import {mergeExactProfiles,parseUniqueJson,canonicalJson} from './profile-catalog-core.mjs';

const MODES = new Set(['CHAT', 'WORK']);
const CONTROL_PATH_ORDER = Object.freeze(['model', 'thinking_effort', 'conversation_origin', 'service_tier']);
const CONTROL_PATHS = new Set(CONTROL_PATH_ORDER);
const ROOT_KEYS = new Set(['schema', 'registrySchemaVersion', 'appVersion', 'profiles']);
const PROFILE_KEYS = new Set(['signal', 'request', 'operations', 'fingerprint', 'builtIn']);
const SIGNAL_KEYS = new Set(['model', 'reasoning']);
const SIGNAL_TOKEN_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const FP_RE = /^[0-9a-f]{64}$/;
const RESERVED_SIGNALS=new Set(['body','none','null','true','false','keep','chat','work','model','reasoning','recovery_id','next_input_b64url','self_run_turn_completed']);
const DOC_MIME = 'application/vnd.google-apps.document';
const DOCS_API = 'https://docs.googleapis.com/v1/documents';

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function allowedKeys(value, allowed) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function signalToken(value) {
  const token = String(value ?? '').trim().toLowerCase();
  return SIGNAL_TOKEN_RE.test(token)&&!RESERVED_SIGNALS.has(token) ? token : '';
}

function profileLabel(mode, profile) {
  if (mode === 'CHAT') return String(profile?.signal?.reasoning || '');
  return String(profile?.signal?.model || '') + '/' + String(profile?.signal?.reasoning || '');
}

export function canonicalOperations(operations) {
  if (!Array.isArray(operations)) throw new Error('OPERATIONS_REQUIRED');
  const byPath = new Map();
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error('OPERATION_OBJECT_REQUIRED');
    }
    const op = String(operation.op || '').toUpperCase();
    const profilePath = String(operation.path || '');
    if (!CONTROL_PATHS.has(profilePath) || byPath.has(profilePath)) {
      throw new Error('OPERATION_PATH_INVALID_OR_DUPLICATE:' + profilePath);
    }
    if (op === 'SET') {
      if (!own(operation, 'value') || typeof operation.value !== 'string' || operation.value.length > 512) {
        throw new Error('SET_VALUE_INVALID:' + profilePath);
      }
      if (!exactKeys(operation, new Set(['op', 'path', 'value']))) {
        throw new Error('SET_SHAPE_INVALID:' + profilePath);
      }
      byPath.set(profilePath, { op: 'SET', path: profilePath, value: operation.value });
    } else if (op === 'REMOVE') {
      if (own(operation, 'value') || !exactKeys(operation, new Set(['op', 'path']))) {
        throw new Error('REMOVE_SHAPE_INVALID:' + profilePath);
      }
      byPath.set(profilePath, { op: 'REMOVE', path: profilePath });
    } else {
      throw new Error('OPERATION_KIND_INVALID:' + profilePath);
    }
  }
  if (
    byPath.size !== CONTROL_PATH_ORDER.length
    || CONTROL_PATH_ORDER.some((profilePath) => !byPath.has(profilePath))
  ) {
    throw new Error('ABSOLUTE_PROFILE_REQUIRED');
  }
  return CONTROL_PATH_ORDER.map((profilePath) => byPath.get(profilePath));
}

export function fingerprint(mode, operations) {
  if (!MODES.has(mode)) throw new Error('INVALID_MODE');
  const canonical = canonicalOperations(operations);
  let source = 'selfrun-profile-registry-v1\n' + mode + '\n';
  for (const operation of canonical) {
    source += operation.op + '|' + operation.path + '|'
      + (operation.op === 'SET' ? operation.value : '') + '\n';
  }
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export function operationsFromRequest(request) {
  if (
    !request
    || typeof request !== 'object'
    || Array.isArray(request)
    || !allowedKeys(request, CONTROL_PATHS)
  ) {
    throw new Error('REQUEST_SHAPE_INVALID');
  }
  return CONTROL_PATH_ORDER.map((profilePath) => (
    own(request, profilePath)
      ? { op: 'SET', path: profilePath, value: String(request[profilePath]) }
      : { op: 'REMOVE', path: profilePath }
  ));
}

export function buildProfile(mode, {
  signalModel = '',
  signalReasoning,
  request,
  builtIn = false,
}) {
  if (!MODES.has(mode)) throw new Error('INVALID_MODE');
  const signal = {};
  if (mode === 'WORK') signal.model = signalToken(signalModel);
  signal.reasoning = signalToken(signalReasoning);
  const normalizedRequest = {};
  for (const profilePath of CONTROL_PATH_ORDER) {
    if (own(request || {}, profilePath)) normalizedRequest[profilePath] = String(request[profilePath]);
  }
  const operations = operationsFromRequest(normalizedRequest);
  return {
    signal,
    request: normalizedRequest,
    operations,
    fingerprint: fingerprint(mode, operations),
    builtIn: builtIn === true,
  };
}

function operationIdentity(operations, profilePath) {
  const operation = canonicalOperations(operations).find((item) => item.path === profilePath);
  return operation.op + ':' + (operation.op === 'SET' ? operation.value : '');
}

function requestValue(profile, profilePath) {
  return own(profile.request, profilePath) ? String(profile.request[profilePath]) : '';
}

function validateProfile(mode, profile, reasons, index) {
  const label = profileLabel(mode, profile) || String(index);
  if (!exactKeys(profile, PROFILE_KEYS)) {
    reasons.push('PROFILE_KEYS_INVALID:' + label);
    return;
  }
  if (!profile.signal || !allowedKeys(profile.signal, SIGNAL_KEYS)) {
    reasons.push('SIGNAL_SHAPE_INVALID:' + label);
  }
  const reasoning = signalToken(profile.signal?.reasoning);
  if (!reasoning) reasons.push('SIGNAL_REASONING_INVALID:' + label);
  if (mode === 'CHAT') {
    if (own(profile.signal || {}, 'model') && String(profile.signal.model || '') !== '') {
      reasons.push('CHAT_SIGNAL_MODEL_FORBIDDEN:' + label);
    }
  } else if (!signalToken(profile.signal?.model)) {
    reasons.push('WORK_SIGNAL_MODEL_REQUIRED:' + label);
  }
  if (
    !profile.request
    || !allowedKeys(profile.request, CONTROL_PATHS)
    || typeof profile.request.model !== 'string'
    || !profile.request.model
  ) {
    reasons.push('REQUEST_INVALID:' + label);
  }
  let canonical;
  try {
    canonical = canonicalOperations(profile.operations);
  } catch (error) {
    reasons.push(String(error?.message || error) + ':' + label);
    return;
  }
  for (const operation of canonical) {
    if (operation.op === 'SET') {
      if (
        !own(profile.request, operation.path)
        || String(profile.request[operation.path]) !== operation.value
      ) {
        reasons.push('REQUEST_OPERATION_MISMATCH:' + label + ':' + operation.path);
      }
    } else if (own(profile.request, operation.path)) {
      reasons.push('REQUEST_REMOVE_MISMATCH:' + label + ':' + operation.path);
    }
  }
  if (
    typeof profile.fingerprint !== 'string'
    || !FP_RE.test(profile.fingerprint)
    || fingerprint(mode, canonical) !== profile.fingerprint
  ) {
    reasons.push('FINGERPRINT_INVALID:' + label);
  }
  if (typeof profile.builtIn !== 'boolean') reasons.push('BUILTIN_INVALID:' + label);
  const requestModel = String(profile.request?.model || '');
  if (mode === 'WORK' && !requestModel.endsWith('-wm')) reasons.push('WORK_MODEL_INVALID:' + label);
  if (mode === 'CHAT' && requestModel.endsWith('-wm')) reasons.push('CHAT_WORK_MIX:' + label);
}

export function validateSnapshot(mode, profiles) {
  const reasons = [];
  if (!MODES.has(mode)) reasons.push('INVALID_MODE');
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return { ok: false, reasons: ['EMPTY_SNAPSHOT'] };
  }
  if(profiles.length>128)return {ok:false,reasons:['PROFILE_LIMIT_EXCEEDED']};
  const fingerprints = new Set();
  const chatReasoning = new Set();
  const workPairs = new Set();
  const workModelSignals = new Map();
  const workReasoningEfforts = new Map();
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      reasons.push('PROFILE_NOT_OBJECT:' + index);
      continue;
    }
    validateProfile(mode, profile, reasons, index);
    if (typeof profile.fingerprint === 'string') {
      if (fingerprints.has(profile.fingerprint)) {
        reasons.push('DUPLICATE_FINGERPRINT:' + profile.fingerprint);
      }
      fingerprints.add(profile.fingerprint);
    }
    if (mode === 'CHAT') {
      const reasoning = signalToken(profile.signal?.reasoning);
      if (reasoning) {
        if (chatReasoning.has(reasoning)) reasons.push('DUPLICATE_CHAT_SIGNAL:' + reasoning);
        chatReasoning.add(reasoning);
      }
    } else {
      const modelSignal = signalToken(profile.signal?.model);
      const reasoning = signalToken(profile.signal?.reasoning);
      if (modelSignal && reasoning) {
        const pair = modelSignal + '\0' + reasoning;
        if (workPairs.has(pair)) reasons.push('DUPLICATE_WORK_SIGNAL_PAIR:' + modelSignal + '/' + reasoning);
        workPairs.add(pair);
        const requestModel = requestValue(profile, 'model');
        if (workModelSignals.has(modelSignal) && workModelSignals.get(modelSignal) !== requestModel) {
          reasons.push('WORK_MODEL_SIGNAL_COLLISION:' + modelSignal);
        } else {
          workModelSignals.set(modelSignal, requestModel);
        }
        let effort = 'INVALID';
        try {
          effort = operationIdentity(profile.operations, 'thinking_effort');
        } catch {}
        if (
          workReasoningEfforts.has(reasoning)
          && workReasoningEfforts.get(reasoning) !== effort
        ) {
          reasons.push('WORK_REASONING_SIGNAL_COLLISION:' + reasoning);
        } else {
          workReasoningEfforts.set(reasoning, effort);
        }
      }
    }
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function validateRegistry(mode, registry) {
  const reasons = [];
  if (!MODES.has(mode)) reasons.push('INVALID_MODE');
  if (!exactKeys(registry, ROOT_KEYS)) reasons.push('REGISTRY_ROOT_KEYS_INVALID');
  const expectedSchema = mode === 'CHAT'
    ? 'selfrun-chat-profile-registry-v1'
    : 'selfrun-work-profile-registry-v1';
  if (registry?.schema !== expectedSchema) reasons.push('REGISTRY_SCHEMA_INVALID');
  if (registry?.registrySchemaVersion !== 1) reasons.push('REGISTRY_SCHEMA_VERSION_INVALID');
  if (typeof registry?.appVersion !== 'string') reasons.push('REGISTRY_APP_VERSION_INVALID');
  const snapshot = validateSnapshot(mode, registry?.profiles);
  reasons.push(...snapshot.reasons);
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function snapshotHash(profiles) {
  return createHash('sha256').update(JSON.stringify(profiles)).digest('hex');
}

function profileSignalKey(mode, profile) {
  if (mode === 'CHAT') return signalToken(profile?.signal?.reasoning);
  return signalToken(profile?.signal?.model) + '\0' + signalToken(profile?.signal?.reasoning);
}

function preserveBuiltIn(mode, currentProfiles, nextProfiles) {
  const bySignal = new Map(
    (currentProfiles || []).map((profile) => [profileSignalKey(mode, profile), profile]),
  );
  return nextProfiles.map((profile) => {
    const current = bySignal.get(profileSignalKey(mode, profile));
    return {
      ...profile,
      builtIn: current && typeof current.builtIn === 'boolean' ? current.builtIn : false,
    };
  });
}

export function replaceProfiles(mode, registry, profiles) {
  const currentValidation = validateRegistry(mode, registry);
  if (!currentValidation.ok) {
    throw new Error('CURRENT_REGISTRY_INVALID:' + currentValidation.reasons.join(','));
  }
  const next = { ...registry, profiles: preserveBuiltIn(mode, registry.profiles, profiles) };
  const nextValidation = validateRegistry(mode, next);
  if (!nextValidation.ok) {
    throw new Error('NEXT_REGISTRY_INVALID:' + nextValidation.reasons.join(','));
  }
  return next;
}

function docBody(document) {
  if (document?.body?.content) return document.body.content;
  const tabs = Array.isArray(document?.tabs) ? document.tabs : [];
  if (tabs.length !== 1) throw new Error('REGISTRY_DOC_SINGLE_TAB_REQUIRED');
  const body = tabs[0]?.documentTab?.body ?? tabs[0]?.body;
  if (!body?.content) throw new Error('REGISTRY_DOC_BODY_REQUIRED');
  return body.content;
}

function extractDocText(document) {
  const out = [];
  for (const item of docBody(document)) {
    for (const element of item?.paragraph?.elements || []) {
      if (typeof element?.textRun?.content === 'string') out.push(element.textRun.content);
    }
  }
  const text = out.join('');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function docDeleteEndIndex(document) {
  let end = 1;
  for (const item of docBody(document)) {
    if (Number.isInteger(item?.endIndex)) end = Math.max(end, item.endIndex);
  }
  return Math.max(1, end - 1);
}

export class GoogleDocsRegistryStore {
  constructor(drive) {
    this.drive = drive;
  }

  async read(documentId) {
    const metadata = await this.drive.getMetadata(documentId);
    if (
      metadata?.id !== documentId
      || metadata?.mimeType !== DOC_MIME
      || metadata?.trashed === true
    ) {
      throw new Error('REGISTRY_DOCUMENT_METADATA_INVALID');
    }
    const response = await this.drive.request(
      DOCS_API + '/' + encodeURIComponent(documentId) + '?includeTabsContent=true',
      { headers: { 'cache-control': 'no-store' } },
    );
    const raw = await response.text();
    if (!response.ok) {
      throw new Error('REGISTRY_DOC_READ_FAILED:' + response.status + ':' + raw.slice(0, 300));
    }
    const document = JSON.parse(raw || '{}');
    const text = extractDocText(document);
    let value;
    try {
      value = parseUniqueJson(text);
    } catch {
      throw new Error('REGISTRY_DOC_JSON_INVALID');
    }
    return { value, raw: text, revisionId: document.revisionId || null, document };
  }

  async write(documentId, value, readState = null) {
    const target = JSON.stringify(value);
    const state = readState || await this.read(documentId);
    const requests = [];
    const end = docDeleteEndIndex(state.document);
    if (end > 1) {
      requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end } } });
    }
    requests.push({ insertText: { location: { index: 1 }, text: target } });
    let response;
    try {
      response = await this.drive.request(
        DOCS_API + '/' + encodeURIComponent(documentId) + ':batchUpdate',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requests,
            ...(state.revisionId
              ? { writeControl: { requiredRevisionId: state.revisionId } }
              : {}),
          }),
        },
      );
    } catch (error) {
      const observed = await this.read(documentId).catch(() => null);
      if (observed?.raw === target) return observed;
      throw error;
    }
    const raw = await response.text();
    if (!response.ok) {
      const observed = await this.read(documentId).catch(() => null);
      if (observed?.raw === target) return observed;
      throw new Error('REGISTRY_DOC_WRITE_FAILED:' + response.status + ':' + raw.slice(0, 300));
    }
    return await this.read(documentId);
  }
}

export class LocalProfileSyncStateStore {
  constructor(root) {
    this.root = root;
  }

  file(mode) {
    return path.join(this.root, mode.toLowerCase() + '.json');
  }

  async read(mode) {
    const result = await readJsonStrict(this.file(mode));
    if (result.kind === 'MISSING') return null;
    if (!result.ok) throw new Error('PROFILE_SYNC_STATE_INVALID:' + mode);
    return result.value;
  }

  async write(mode, value) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const next = {
      schema: 'selfrun-profile-registry-sync-state-v1',
      mode,
      source_identity: value?.source_identity ?? null,
      snapshot_hash: value?.snapshot_hash ?? null,
      last_success_at: value?.last_success_at ?? new Date().toISOString(),
    };
    await atomicWriteJson(this.file(mode), next);
    return next;
  }
}

export class ProfileRegistrySynchronizer {
  constructor({ mode, documentId, source, store, stateStore, isActive, now = () => new Date().toISOString(), dryRun = false, minimumRetentionRatio = 0.5, requireWriteRevision = false }) {
    Object.assign(this, { mode, documentId, source, store, stateStore, isActive, now, dryRun, minimumRetentionRatio, requireWriteRevision });
  }

  async run() {
    if (!(await this.isActive())) return { status: 'STANDBY_NOOP' };
    const priorState = typeof this.stateStore?.read === 'function'
      ? await this.stateStore.read(this.mode)
      : null;
    let probed = null;
    if (typeof this.source?.probe === 'function') {
      try {
        probed = await this.source.probe();
      } catch (error) {
        return { status: 'SOURCE_PROBE_FAILED', error: String(error?.message || error) };
      }
      if (probed?.identity && priorState?.source_identity === probed.identity) {
        return {
          status: 'SOURCE_IDENTITY_UNCHANGED',
          source_identity: probed.identity,
          snapshot_hash: priorState.snapshot_hash || null,
        };
      }
    }

    let upstream;
    try {
      upstream = await this.source.fetch(probed);
    } catch (error) {
      return { status: 'SOURCE_FAILED', error: String(error?.message || error) };
    }
    if(upstream?.reconcile_current_profiles===true&&upstream.current_selectable_zero_verified===true&&Array.isArray(upstream.profiles)&&upstream.profiles.length===0)return {status:'CURRENT_SELECTABLE_ZERO_BLOCKED',reasons:['VERIFIED_CURRENT_SELECTABLE_ZERO','APP_V1_EMPTY_REGISTRY_UNSUPPORTED'],publication_success:false,current_registry_verified_current:false};
    if(upstream?.reconcile_current_profiles===true && upstream.catalog_complete!==true) return {status:'SNAPSHOT_REJECTED',reasons:['CURRENT_CATALOG_INCOMPLETE']};
    const validation = validateSnapshot(this.mode, upstream?.profiles);
    if (!validation.ok) return { status: 'SNAPSHOT_REJECTED', reasons: validation.reasons };

    const currentState = await this.store.read(this.documentId);
    const current = currentState.value;
    const currentValidation = validateRegistry(this.mode, current);
    if (!currentValidation.ok) {
      return { status: 'CURRENT_REGISTRY_REJECTED', reasons: currentValidation.reasons };
    }

    if(upstream.reconcile_current_profiles===true)upstream=mergeExactProfiles(this.mode,current,upstream);
    let profiles = this.mode === 'CHAT' && upstream.preserve_chat_noncore === true
      ? [...upstream.profiles, ...current.profiles.filter(profile =>
        !['instant', 'medium', 'high', 'xhigh'].includes(profile.signal.reasoning))]
      : upstream.profiles;
    if(this.mode==='WORK' && upstream.reconcile_current_profiles!==true && Array.isArray(upstream.work_tier_policies)) {
      const policies=new Map(upstream.work_tier_policies.map(p=>[p.signal_model+':'+p.signal_reasoning,p]));
      const existing=new Map(current.profiles.map(p=>[p.signal.model+':'+p.signal.reasoning,p]));
      profiles=profiles.map(profile=>{
        const key=profile.signal.model+':'+profile.signal.reasoning,policy=policies.get(key);
        if(!policy||!Array.isArray(policy.options))throw Error('WORK_TIER_POLICY_UNVERIFIED');
        const selected=existing.get(key)?.request.service_tier;
        const tier=policy.options.includes(selected)?selected:policy.options.includes(policy.default_tier)?policy.default_tier:policy.options[0];
        const request={...profile.request};delete request.service_tier;if(tier)request.service_tier=tier;
        return buildProfile('WORK',{signalModel:profile.signal.model,signalReasoning:profile.signal.reasoning,request,builtIn:profile.builtIn});
      });
      // A catalog omission is not evidence of permanent deactivation.
      for(const [key,profile] of existing)if(!policies.has(key))profiles.push(profile);
    }
    const currentCount = current.profiles.length;
    const nextCount = profiles.length;
    if (currentCount >= 4 && nextCount < Math.ceil(currentCount * this.minimumRetentionRatio) && upstream?.confirmed_deactivation !== true && !(upstream?.reconcile_current_profiles===true && upstream.catalog_complete===true)) {
      return { status: 'SNAPSHOT_REJECTED', reasons: ['IMPLAUSIBLE_SHARP_COLLAPSE:' + currentCount + '->' + nextCount] };
    }

    const next = replaceProfiles(this.mode, current, profiles);

    const before = snapshotHash(current.profiles);
    const after = snapshotHash(next.profiles);
    const sourceIdentity = upstream.identity ?? probed?.identity ?? null;
    if (before === after) {

      if (!(await this.isActive())) return { status: 'STANDBY_NOOP_BEFORE_STATE' };
      await this.stateStore.write(this.mode, {
        source_identity: sourceIdentity,
        snapshot_hash: after,
        last_success_at: this.now(),
      });
      return {
        status: 'UNCHANGED',
        source_identity: sourceIdentity,
        snapshot_hash: after,
        count: next.profiles.length,
        
      };
    }

    if (this.dryRun) {

      return {
        status: 'DRY_RUN_CHANGE',
        source_identity: sourceIdentity,
        before_hash: before,
        snapshot_hash: after,
        before_count: current.profiles.length,
        count: next.profiles.length,
        
      };
    }

    if (!(await this.isActive())) return { status: 'STANDBY_NOOP_BEFORE_WRITE' };
    if (this.requireWriteRevision && !currentState.revisionId) return { status: 'WRITE_REVISION_REQUIRED' };
    await this.store.write(this.documentId, next, currentState);
    const readback = await this.store.read(this.documentId);
    if (JSON.stringify(readback.value) !== JSON.stringify(next)) {
      throw new Error('REGISTRY_READBACK_MISMATCH');
    }
    const readbackValidation = validateRegistry(this.mode, readback.value);
    if (!readbackValidation.ok) {
      throw new Error('REGISTRY_READBACK_INVALID:' + readbackValidation.reasons.join(','));
    }

    await this.stateStore.write(this.mode, {
      source_identity: sourceIdentity,
      snapshot_hash: after,
      last_success_at: this.now(),
    });
    return {
      status: 'UPDATED',
      source_identity: sourceIdentity,
      snapshot_hash: after,
      count: next.profiles.length,
      
    };
  }
}
