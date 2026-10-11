import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { processIdentity, writePrivateJournal } from './profile-sync-recovery.mjs';
import { buildReadableChatSignalDetails, assertReadableSignalUnique } from './profile-readable-signals.mjs';
import { buildProfile } from './profile-registry-sync.mjs';
import { idle as isSelfRunIdle, ownedListener } from './profile-chat-collector.mjs';

const NO_TAB_STATUSES = new Set(['device_identity_unverified','extension_owner_or_endpoint_unverified','idle_server_unverified','verified_production_modules_unavailable','production_android_config_not_available_in_worker','production_profile_configuration_unverified','production_profile_configuration_mismatch','extension_endpoint_changed','idle_or_owner_changed','collector_permit_unverified']);
function cleanupVerified(catalog) {return catalog?.own_tab_cleanup === 'closed' || catalog?.own_tab_cleanup === 'not_required' || NO_TAB_STATUSES.has(catalog?.status);}
// execFile's abort callback can fire before the child finishes cleanup. Hold ownership until close.
export function runCollectorProcess(file, args, options) {
  return new Promise((resolve, reject) => {
    let failure = null, stdout = '', overflow = false;
    const { signal, timeout, ownershipJournal, reservationOwner, ...childOptions } = options;
    if(ownershipJournal)writePrivateJournal(ownershipJournal,{schema:'profile-sync-collector-owner-v1',owner:reservationOwner,worker:processIdentity(),phase:'launching',child:null});
    const child = execFile(file, args, childOptions, error => { failure ||= error; });
    if(ownershipJournal){const identity=processIdentity(child.pid);if(!identity){child.kill('SIGTERM');failure=Error('CHILD_IDENTITY_UNVERIFIED');}else writePrivateJournal(ownershipJournal,{schema:'profile-sync-collector-owner-v1',owner:reservationOwner,worker:processIdentity(),phase:'permitted',child:identity});}
    const stop = () => { failure ||= Error('CHAT_NORMAL_COLLECTOR_CANCELLED'); child.kill(options.killSignal || 'SIGTERM'); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const timer = timeout ? setTimeout(stop, timeout) : null;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {if(stdout.length + chunk.length > 196608)overflow=true;else stdout += chunk.toString('utf8');});
    child.once('close', () => {
      if(timer)clearTimeout(timer);signal?.removeEventListener('abort', stop);
      if(failure || overflow){let verified=false;try{verified=cleanupVerified(JSON.parse(stdout));}catch{}const error=Error('CHAT_NORMAL_COLLECTOR_FAILED');error.cleanupVerified=verified;reject(error);}
      else resolve({stdout});
    });
  });
}
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const token = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,79}$/.test(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value);
const label = value => typeof value === 'string' && [...value].length <= 100
  && !/\p{Cc}/u.test(value) && !/[\uD800-\uDFFF]/u.test(value)
  && !/(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.test(value) ? value : null;
const availabilityKeys = ['enabled', 'disabled', 'hidden', 'is_hidden', 'is_admin_only', 'admin_only', 'disabled_by_admin'];
function selectable(row, requireEnabled = false) {
  for (const key of availabilityKeys) {
    if (own(row, key) && row[key] !== null && typeof row[key] !== 'boolean') throw Error('CHAT_NORMAL_AVAILABILITY_INVALID');
  }
  return (!requireEnabled || row.enabled === true) && row.enabled !== false
    && !availabilityKeys.slice(1).some(key => row[key] === true)
    && !(Array.isArray(row.tags) && row.tags.some(tag => ['hidden', 'is_hidden', 'admin_only', 'is_admin_only'].includes(tag)));
}
function effortState(preset) {
  const present = own(preset, 'thinking_effort'), state = preset.field_states?.thinking_effort;
  if (state && (state.state !== (present ? 'present' : 'absent')
      || (present && state.type !== (preset.thinking_effort === null ? 'null' : typeof preset.thinking_effort)))) {
    throw Error('CHAT_NORMAL_EFFORT_STATE_MISMATCH');
  }
  return present;
}

function sourceIndex(row, fallback, bound, seen) {
  const index = own(row, 'source_index') ? row.source_index : fallback;
  if (!Number.isSafeInteger(index) || index < 0 || index >= bound || seen.has(index)) throw Error('CHAT_NORMAL_SOURCE_INDEX_INVALID');
  seen.add(index);
  return index;
}

// Presets are exact account-selectable requests; supported efforts never manufacture requests.
export function parseNormalChatCatalog(catalog, { observedAt = new Date().toISOString() } = {}) {
  const criticalIssues = catalog?.schema?.critical_issue_count ?? catalog?.schema?.issue_count ?? 0;
  if (!['ok', 'ok_partial'].includes(catalog?.status) || criticalIssues > 0
      || !Array.isArray(catalog.models) || !Array.isArray(catalog.versions)
      || catalog.models.length > 256 || catalog.versions.length > 256) throw Error('CHAT_NORMAL_CATALOG_REJECTED');
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) throw Error('CHAT_NORMAL_OBSERVATION_TIME_INVALID');
  observedAt = new Date(observedAt).toISOString();
  const models = new Map(), modelIndexes = new Set();
  for (const [index, model] of catalog.models.entries()) {
    if (!token(model?.slug) || models.has(model.slug)) throw Error('CHAT_NORMAL_MODEL_AMBIGUOUS');
    const originalIndex = sourceIndex(model, index, 256, modelIndexes);
    if (Array.isArray(model.thinking_efforts)) {
      const effortIndexes = new Set();
      for (const [ei, effort] of model.thinking_efforts.entries()) sourceIndex(effort && typeof effort === 'object' ? effort : {}, ei, 128, effortIndexes);
    }
    models.set(model.slug, { model, index: originalIndex });
  }
  if (own(catalog, 'categories') && (!Array.isArray(catalog.categories) || catalog.categories.length > 256)) throw Error('CHAT_NORMAL_CATEGORY_INVALID');
  const categoryIndexes = new Set();
  const categories = (catalog.categories ?? []).map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || (own(row, 'default_model') && row.default_model !== null && !token(row.default_model))
        || (own(row, 'supported_models') && row.supported_models !== null && (!Array.isArray(row.supported_models) || row.supported_models.length > 256 || !row.supported_models.every(token)))) throw Error('CHAT_NORMAL_CATEGORY_INVALID');
    const originalIndex = sourceIndex(row, index, 256, categoryIndexes);
    return { row, index: originalIndex, selectable: selectable(row) };
  });
  const profiles = new Map(), presentation = new Map(), selectablePresets = [], held = [], blockers = new Set(), versionIds = new Set(), versionIndexes = new Set();
  for (const [versionIndex, version] of catalog.versions.entries()) {
    if (!version || typeof version !== 'object' || Array.isArray(version)) throw Error('CHAT_NORMAL_VERSION_INVALID');
    const vi = sourceIndex(version, versionIndex, 256, versionIndexes);
    const versionId = identifier(version.id) ? version.id : null;
    if (versionId !== null && versionIds.has(versionId)) throw Error('CHAT_NORMAL_VERSION_AMBIGUOUS');
    if (versionId !== null) versionIds.add(versionId);
    const versionSelectable = selectable(version, true);
    if (typeof version.enabled !== 'boolean') blockers.add('version_availability_unverified');
    if (!Array.isArray(version.slugs) || !version.slugs.every(token)
        || !Array.isArray(version.intelligence_presets)) throw Error('CHAT_NORMAL_VERSION_INVALID');
    if (version.intelligence_presets.length > 128) throw Error('CHAT_NORMAL_PROFILE_LIMIT');
    const presetIndexes = new Set();
    for (const [presetIndex, preset] of version.intelligence_presets.entries()) {
      if (!preset || typeof preset !== 'object' || Array.isArray(preset)) throw Error('CHAT_NORMAL_PRESET_UNRECOGNIZED');
      const pi = sourceIndex(preset, presetIndex, 128, presetIndexes);
      if (preset.preset_type === 'upgrade') continue;
      const presetSelectable = selectable(preset);
      if (preset.preset_type !== 'available' || !token(preset.model_slug)) throw Error('CHAT_NORMAL_PRESET_UNRECOGNIZED');
      const entry = models.get(preset.model_slug);
      if (!entry || !version.slugs.includes(preset.model_slug)) throw Error('CHAT_NORMAL_PRESET_MODEL_UNVERIFIED');
      const { model, index: mi } = entry;
      if (model.is_work_mode_model === true || model.slug.endsWith('-wm')) continue;
      const linkedCategories = categories.filter(({ row }) => row.default_model === model.slug || row.supported_models?.includes(model.slug));
      const modelSelectable = selectable(model) && linkedCategories.every(category => category.selectable);
      if (model.is_work_mode_model !== false) throw Error('CHAT_NORMAL_PRESET_MODEL_UNVERIFIED');
      const present = effortState(preset);
      const available = versionSelectable && presetSelectable && modelSelectable;
      let executionEfforts, requestMapping;
      if (present && preset.thinking_effort === null) {
        held.push({ version_id: versionId, model_slug: model.slug, preset_index: pi, reason: 'explicit_null_effort_unmapped' });
        if (available) blockers.add('explicit_null_effort_unmapped');
        continue;
      }
      if (present && !token(preset.thinking_effort)) throw Error('CHAT_NORMAL_EFFORT_INVALID');
      if (preset.lane === 'instant' && model.configurable_thinking_effort === false && model.reasoning_type === 'none' && !present) {
        executionEfforts = [undefined]; requestMapping = 'instant_nonconfigurable_remove';
      } else if (preset.lane === 'thinking' && model.configurable_thinking_effort === true && model.reasoning_type === 'reasoning' && present) {
        executionEfforts = [preset.thinking_effort]; requestMapping = 'thinking_exact_preset';
      } else if (preset.lane === 'pro' && model.configurable_thinking_effort === true && model.reasoning_type === 'pro' && !present) {
        if (!Array.isArray(model.thinking_efforts) || model.thinking_efforts.length < 1 || model.thinking_efforts.length > 2
            || model.thinking_efforts.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !['standard', 'extended'].includes(row.thinking_effort))) throw Error('CHAT_NORMAL_PRO_EFFORT_UNVERIFIED');
        executionEfforts = model.thinking_efforts.map(row => row.thinking_effort);
        if (!executionEfforts.includes('standard') || new Set(executionEfforts).size !== executionEfforts.length) throw Error('CHAT_NORMAL_PRO_EFFORT_UNVERIFIED');
        requestMapping = 'pro_ui_effort';
      } else {
        const reason = 'selector_request_mapping_unverified';
        held.push({ version_id: versionId, model_slug: model.slug, preset_index: pi, reason });
        if (available) blockers.add(reason);
        continue;
      }
      for (const executionEffort of executionEfforts) {
      const executionPresent = executionEffort !== undefined;
      let effortIndex = -1, effort = null;
      if (executionPresent) {
        if (model.reasoning_type !== 'reasoning' && model.reasoning_type !== 'pro') throw Error('CHAT_NORMAL_REASONING_TYPE_UNVERIFIED');
        if (!Array.isArray(model.thinking_efforts)) throw Error('CHAT_NORMAL_EFFORT_NOT_SUPPORTED');
        const matching = model.thinking_efforts.map((item, index) => ({ item, index })).filter(({ item }) => (typeof item === 'string' ? item : item?.thinking_effort) === executionEffort);
        if (matching.length !== 1) throw Error('CHAT_NORMAL_EFFORT_NOT_SUPPORTED');
        effortIndex = matching[0].item?.source_index ?? matching[0].index;
        effort = typeof matching[0].item === 'object' ? matching[0].item : null;
        if (effort) effortState(effort);
      } else if (model.reasoning_type !== 'none' && model.reasoning_type !== 'pro') throw Error('CHAT_NORMAL_REASONING_TYPE_UNVERIFIED');
      const availabilityStatus = available ? 'observed_selectable' : 'observed_unavailable';
      const request = { model: model.slug, ...(executionPresent ? { thinking_effort: executionEffort } : {}) };
      const draft = buildProfile('CHAT', { signalReasoning: 'draft', request });
      const profile = buildProfile('CHAT', { signalReasoning: 'c.' + draft.fingerprint, request });
      const mp = 'models[' + mi + ']', pp = 'versions[' + vi + '].intelligence_presets[' + pi + ']';
      const ep = effortIndex >= 0 ? mp + '.thinking_efforts[' + effortIndex + ']' : null;
      const availabilitySourceFields = ['versions[' + vi + '].enabled', pp + '.preset_type', mp + '.is_work_mode_model', pp + '.lane', mp + '.configurable_thinking_effort'];
      if (ep) availabilitySourceFields.push(ep + '.thinking_effort');
      for (const [row, prefix] of [[version, 'versions[' + vi + ']'], [preset, pp], [model, mp], ...linkedCategories.map(category => [category.row, 'categories[' + category.index + ']'])]) {
        for (const key of availabilityKeys) {
          const source = prefix + '.' + key;
          if ((key === 'enabled' && row[key] === false) || (key !== 'enabled' && row[key] === true)) {
            if (!availabilitySourceFields.includes(source)) availabilitySourceFields.push(source);
          }
        }
        if (Array.isArray(row.tags) && row.tags.some(tag => ['hidden', 'is_hidden', 'admin_only', 'is_admin_only'].includes(tag))) availabilitySourceFields.push(prefix + '.tags');
      }
      if (availabilitySourceFields.length > 16) throw Error('CHAT_NORMAL_AVAILABILITY_SOURCE_LIMIT');
      const sourceFields = { modelTitle: mp + '.title', effortTitle: pp + '.title', selectedDisplayTitle: pp + '.selected_display_title', locale: null };
      const origin = { observedAt, versionId, modelSlug: model.slug,
        thinkingEffortState: executionPresent ? 'present' : 'absent', thinkingEffort: executionPresent ? executionEffort : null, requestMapping,
        presetIndex: pi, modelTitle: label(model.title), presetTitle: label(preset.title),
        selectedDisplayTitle: label(preset.selected_display_title), fullLabel: label(effort?.full_label),
        shortLabel: label(effort?.short_label), mobileFullLabel: label(effort?.mobile_full_label),
        sourceFields: { modelTitle: mp + '.title', presetTitle: pp + '.title', selectedDisplayTitle: pp + '.selected_display_title',
          thinkingEffort: requestMapping === 'pro_ui_effort' ? ep + '.thinking_effort' : executionPresent ? pp + '.thinking_effort' : null, fullLabel: ep === null ? null : ep + '.full_label', shortLabel: ep === null ? null : ep + '.short_label', mobileFullLabel: ep === null ? null : ep + '.mobile_full_label' },
        availabilityStatus, availabilitySourceFields };
      if (available && !profiles.has(profile.fingerprint)) {
        if (profiles.size >= 128) throw Error('CHAT_NORMAL_PROFILE_LIMIT');
        profiles.set(profile.fingerprint, profile);
      }
      if (!presentation.has(profile.fingerprint)) {
        if (presentation.size >= 128) throw Error('CHAT_NORMAL_PROFILE_LIMIT');
        const values = { modelTitle: origin.modelTitle, effortTitle: origin.presetTitle, selectedDisplayTitle: origin.selectedDisplayTitle, locale: null };
        presentation.set(profile.fingerprint, { fingerprint: profile.fingerprint, status: availabilityStatus, availabilityObservedAt: observedAt,
          ...values, labelObservedAt: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === null ? null : observedAt])), sourceFields, origins: [] });
      }
      const row = presentation.get(profile.fingerprint);
      if (row.origins.length >= 128) throw Error('CHAT_NORMAL_ORIGIN_LIMIT');
      row.origins.push(origin);
      if (available && row.status !== 'observed_selectable') {
        const values = { modelTitle: origin.modelTitle, effortTitle: origin.presetTitle, selectedDisplayTitle: origin.selectedDisplayTitle, locale: null };
        Object.assign(row, { status: 'observed_selectable', availabilityObservedAt: observedAt, ...values,
          labelObservedAt: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === null ? null : observedAt])), sourceFields });
      }
      if (available) selectablePresets.push({ version_id: versionId, model_slug: model.slug, preset_type: 'available', effort_state: executionPresent ? 'present' : 'absent', preset_effort_state: present ? 'present' : 'absent', request_mapping: requestMapping, ...(executionPresent ? { thinking_effort: executionEffort } : {}) });
      }
    }
  }
  const readableSignals = new Map(), readableSignalProvenance = [];
  const next = [...profiles.values()].map(profile => {
    const labels = presentation.get(profile.fingerprint);
    const origin = labels.origins.find(origin => origin.availabilityStatus === 'observed_selectable');
    if (!origin) throw Error('CHAT_NORMAL_SELECTABLE_ORIGIN_UNVERIFIED');
    const naming = buildReadableChatSignalDetails({
      effortIdentifierFallback: origin.thinkingEffort === null ? undefined : { officialApiIdentifier: origin.thinkingEffort, sourceField: 'thinkingEffort', sourcePath: origin.sourceFields.thinkingEffort },
      modelCandidates: [{ value: origin.modelTitle, sourceField: 'modelTitle', sourcePath: origin.sourceFields.modelTitle }],
      effortCandidates: [
        ...(origin.requestMapping !== 'pro_ui_effort' || origin.thinkingEffort === 'standard' ? [{ value: origin.selectedDisplayTitle, sourceField: 'selectedDisplayTitle', sourcePath: origin.sourceFields.selectedDisplayTitle },
        { value: origin.presetTitle, sourceField: 'effortTitle', sourcePath: origin.sourceFields.presetTitle }] : []),
        ...['shortLabel', 'fullLabel', 'mobileFullLabel'].map(sourceField => ({ value: origin[sourceField], sourceField, sourcePath: origin.sourceFields[sourceField] })),
      ],
    });
    const { signalReasoning } = naming;
    readableSignalProvenance.push({ fingerprint: profile.fingerprint, signalReasoning, model: naming.model, effort: naming.effort, signalAssemblyRule: naming.signalAssemblyRule });
    assertReadableSignalUnique(readableSignals, signalReasoning, profile.fingerprint);
    return buildProfile('CHAT', { signalReasoning, request: profile.request });
  });
  const observed = [...presentation.values()];
  if (next.length === 0) blockers.add('no_selectable_profiles');
  // Collection timestamps do not alter source identity; observed labels and provenance do.
  const identityValues = JSON.parse(JSON.stringify(observed, (key, value) => ['observedAt', 'availabilityObservedAt', 'labelObservedAt'].includes(key) ? undefined : value));
  return { identity: 'normal-chat:' + createHash('sha256').update(JSON.stringify({ profiles: next, presentation: identityValues, held_observations: held, catalog_blockers: [...blockers] })).digest('hex'),
    profiles: next, current_selectable_zero_verified: next.length===0&&catalog.models.length>0&&catalog.versions.length>0&&blockers.size===1&&blockers.has('no_selectable_profiles'), reconcile_current_profiles: true, catalog_complete: blockers.size === 0, catalog_blockers: [...blockers], presentation: { observedAt, profiles: observed },
    catalog_metadata: { readable_signal_provenance: readableSignalProvenance, mapping_certified: blockers.size === 0, sdk_gate_observation_status: ['unverified', 'observation_only'].includes(catalog.chat_request_gate?.status) ? catalog.chat_request_gate.status : 'unverified', backend_execution_verified: false, request_mapping_basis: 'selfrun_absolute_controls_after_native_body', version_ids: catalog.versions.filter(v => v.enabled === true).map(v => identifier(v.id) ? v.id : null), selectable_presets: selectablePresets,
      held_observations: held, catalog_complete: blockers.size === 0, catalog_blockers: [...blockers], supported_efforts: [...new Set(selectablePresets.map(p => p.model_slug))].map(modelSlug => ({ model_slug: modelSlug,
        efforts: (Array.isArray(models.get(modelSlug).model.thinking_efforts) ? models.get(modelSlug).model.thinking_efforts : [])
          .map(item => typeof item === 'string' ? item : item?.thinking_effort).filter(token) })), request_submission_tested: false } };
}

export async function collectNormalChatCatalog({ signal, deadline, onCleanup, ownershipJournal, reservationOwner, catalogKind = 'CHAT' } = {}) {
  let result;
  try {
    result = await runCollectorProcess(process.execPath, [fileURLToPath(new URL('./profile-chat-collector.mjs', import.meta.url)), '--catalog-kind='+catalogKind, ...(Number.isSafeInteger(deadline) ? ['--lease-deadline-ms=' + deadline] : []), ...(ownershipJournal ? ['--ownership-journal='+ownershipJournal,'--reservation-owner='+reservationOwner] : [])], {
      timeout: 90000, killSignal: 'SIGTERM', maxBuffer: 196608,
      signal, ownershipJournal, reservationOwner,
      // Profile environment is set only by the standalone collector child.
      env: { HOME: '/data/data/com.termux/files/home' },
    });
  } catch (error) {onCleanup?.(error.cleanupVerified===true);throw new Error('CHAT_NORMAL_COLLECTOR_FAILED');}
  try {
    const catalog = JSON.parse(result.stdout);onCleanup?.(cleanupVerified(catalog));
    if (catalog.own_tab_cleanup !== 'closed' || catalog.profile_session_retained !== true
        || catalog.profile_commands !== 3 || catalog.live_server_profile_values_match !== 'verified_fingerprint') {
      throw new Error('CHAT_NORMAL_COLLECTION_UNVERIFIED');
    }
    return catalog;
  } catch { throw new Error('CHAT_NORMAL_COLLECTION_UNVERIFIED'); }
}

export class NormalChatCatalogSource {
  constructor({ collect = collectNormalChatCatalog, canWrite, isActive = async () => true, deadline, ownershipJournal, reservationOwner, parser = parseNormalChatCatalog } = {}) {
    this.parser = parser;
    let owner = null;
    this.canWrite = canWrite || (async () => {
      if (!await isSelfRunIdle()) return false;
      const current = ownedListener();
      if (!current) return false;
      owner ??= current;
      return owner === current;
    });
    this.collect = collect; this.isActive = isActive; this.deadline = deadline; this.ownershipJournal=ownershipJournal;this.reservationOwner=reservationOwner; this.catalogMetadata = null; this.cleanupVerified = true;
  }
  // No Rosetta HEAD shortcut or fallback: failures leave the existing registry untouched.
  async fetch() {
    this.catalogMetadata = null;
    if (!await this.isActive()) throw new Error('CHAT_ACTIVE_ROLE_LOST');
    this.cleanupVerified = false;
    const controller = new AbortController();
    let checking = false;
    const monitor = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.isActive().then(active => { if (!active) controller.abort(); })
        .catch(() => controller.abort()).finally(() => { checking = false; });
    }, 250);
    try {
      const catalog = await this.collect({ signal: controller.signal, deadline: this.deadline, ownershipJournal:this.ownershipJournal,reservationOwner:this.reservationOwner, onCleanup: verified => { this.cleanupVerified = verified === true; } });
      this.cleanupVerified ||= cleanupVerified(catalog);
      if (controller.signal.aborted || !await this.isActive()) throw new Error('CHAT_ACTIVE_ROLE_LOST');
      const result = this.parser(catalog);
      this.catalogMetadata = result.catalog_metadata;
      return result;
    } finally { clearInterval(monitor); }
  }
}
