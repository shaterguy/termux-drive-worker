const RESERVED_SIGNALS = new Set(['body','none','null','true','false','keep','chat','work','model','reasoning','recovery_id','next_input_b64url','self_run_turn_completed']);
const TOKEN = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const NORMALIZATION = 'ascii-camel-space-lowercase-v1';

// Installed v1 pickers render normalized tokens, not exact official typography.
// Backend slugs and previous aliases are deliberately not candidate display names.
export function normalizeReadableToken(officialLabel) {
  if (typeof officialLabel !== 'string' || !/^[A-Za-z0-9 ._:-]+$/.test(officialLabel)) throw Error('READABLE_SIGNAL_UNREPRESENTABLE');
  const token = officialLabel.trim().replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/ +/g, '-').replace(/-+/g, '-').toLowerCase();
  if (!TOKEN.test(token) || RESERVED_SIGNALS.has(token)) throw Error('READABLE_SIGNAL_UNREPRESENTABLE');
  return token;
}

export function selectReadableOfficialToken(candidates, effortIdentifierFallback) {
  if (!Array.isArray(candidates) || candidates.length > 8) throw Error('READABLE_SIGNAL_UNREPRESENTABLE');
  for (const candidate of candidates) {
    let token;
    try { token = normalizeReadableToken(candidate?.value); } catch { continue; }
    if (typeof candidate.sourceField !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(candidate.sourceField)
        || (candidate.sourcePath !== null && (typeof candidate.sourcePath !== 'string' || [...candidate.sourcePath].length > 256
          || /\p{Cc}/u.test(candidate.sourcePath) || /[\uD800-\uDFFF]/u.test(candidate.sourcePath)))) throw Error('READABLE_SIGNAL_PROVENANCE_INVALID');
    return { token, sourceField: candidate.sourceField, sourcePath: candidate.sourcePath,
      normalization: NORMALIZATION, caseChanged: candidate.value !== candidate.value.toLowerCase(), exactOfficial: false, exactOfficialDisplay: false };
  }
  if (effortIdentifierFallback) {
    const { officialApiIdentifier, sourceField, sourcePath } = effortIdentifierFallback;
    if (candidates.some(candidate => candidate?.sourceField === 'modelTitle')
        || typeof officialApiIdentifier !== 'string' || !TOKEN.test(officialApiIdentifier) || RESERVED_SIGNALS.has(officialApiIdentifier)
        || sourceField !== 'thinkingEffort' || typeof sourcePath !== 'string' || sourcePath.length > 256
        || !/^(?:versions\[\d+\]\.intelligence_presets\[\d+\]|models\[\d+\]\.thinking_efforts\[\d+\])\.thinking_effort$/.test(sourcePath)) throw Error('READABLE_SIGNAL_UNREPRESENTABLE');
    for (const candidate of candidates) {
      if (typeof candidate?.sourceField !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(candidate.sourceField)
          || (candidate.sourcePath !== null && (typeof candidate.sourcePath !== 'string' || [...candidate.sourcePath].length > 256
            || /\p{Cc}/u.test(candidate.sourcePath) || /[\uD800-\uDFFF]/u.test(candidate.sourcePath)))) throw Error('READABLE_SIGNAL_PROVENANCE_INVALID');
    }
    const originalOfficialLabels = candidates.map(candidate => ({
      value: typeof candidate?.value === 'string' && [...candidate.value].length <= 100
        && !/\p{Cc}/u.test(candidate.value) && !/[\uD800-\uDFFF]/u.test(candidate.value)
        && !/(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.test(candidate.value) ? candidate.value : null,
      sourceField: candidate?.sourceField ?? null, sourcePath: candidate?.sourcePath ?? null,
    }));
    return { token: officialApiIdentifier, officialApiIdentifier, sourceField, sourcePath,
      normalization: 'identity-api-effort-identifier-v1', reason: 'label_unrepresentable_api_identifier_fallback',
      sourceKind: 'verified_api_effort_identifier', originalOfficialLabels, caseChanged: false,
      exactOfficial: false, exactOfficialDisplay: false };
  }
  throw Error('READABLE_SIGNAL_UNREPRESENTABLE');
}

export function buildReadableChatSignalDetails({ modelCandidates, effortCandidates, effortIdentifierFallback, modelTitle, selectedDisplayTitle, effortTitle, sourceFields = {} }) {
  const model = selectReadableOfficialToken(modelCandidates ?? [{ value: modelTitle, sourceField: 'modelTitle', sourcePath: sourceFields.modelTitle ?? null }]);
  const effort = selectReadableOfficialToken(effortCandidates ?? [
    { value: selectedDisplayTitle, sourceField: 'selectedDisplayTitle', sourcePath: sourceFields.selectedDisplayTitle ?? null },
    { value: effortTitle, sourceField: 'effortTitle', sourcePath: sourceFields.effortTitle ?? null },
  ], effortIdentifierFallback);
  const sharedLaneLabel = ['pro', 'instant'].includes(effort.token) && model.token.endsWith('-' + effort.token);
  const signalReasoning = sharedLaneLabel ? model.token : model.token + '.' + effort.token;
  if (!TOKEN.test(signalReasoning)) throw Error('READABLE_SIGNAL_UNREPRESENTABLE');
  return { signalReasoning, model, effort, signalAssemblyRule: sharedLaneLabel ? 'model-title-with-shared-lane-label' : 'model-title-dot-effort-label' };
}

export function buildReadableChatSignal(options) { return buildReadableChatSignalDetails(options).signalReasoning; }

export function assertReadableSignalUnique(seen, signalKey, fingerprint) {
  if (seen.has(signalKey) && seen.get(signalKey) !== fingerprint) throw Error('READABLE_SIGNAL_COLLISION');
  seen.set(signalKey, fingerprint);
}
