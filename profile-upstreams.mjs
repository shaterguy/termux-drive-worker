import { createHash } from 'node:crypto';
import { buildProfile } from './profile-registry-sync.mjs';

const EFFORT_SIGNAL = Object.freeze({
  min: 'light',
  standard: 'medium',
  extended: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
});

function identityOf(text, prefix = 'sha256') {
  return prefix + ':' + createHash('sha256').update(String(text)).digest('hex');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function modelSignal(slug) {
  return String(slug)
    .replace(/^gpt-/, '')
    .replace(/-wm$/, '')
    .replace(/-/g, '')
    .toLowerCase();
}

function effortValues(record) {
  const direct = Array.isArray(record?.thinking_efforts) ? record.thinking_efforts : [];
  const presets = Array.isArray(record?.intelligence_presets)
    ? record.intelligence_presets
    : [];
  return unique(
    [...direct, ...presets]
      .map((item) => (typeof item === 'string' ? item : item?.thinking_effort))
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => EFFORT_SIGNAL[value]),
  );
}

function catalogRecords(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['models', 'data', 'items', 'records']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function workRequestDefaults(record) {
  const request = record?.request && typeof record.request === 'object'
    ? record.request
    : {};
  const origin = request.conversation_origin ?? record?.conversation_origin;
  if (origin !== 'tpp') {
    throw new Error(
      'WORK_CONVERSATION_ORIGIN_SOURCE_REQUIRED:'
      + String(record?.slug || record?.model_slug || ''),
    );
  }
  const out = { conversation_origin: 'tpp' };
  const tier = request.service_tier ?? record?.service_tier;
  if (tier != null && String(tier) !== '') out.service_tier = String(tier);
  return out;
}

export function parseRosettaChatSnapshot(text) {
  const source = String(text || '');
  const instant = source.match(
    /default[^\x60\n]*lane sends\s+\x60([^\x60]+)\x60\s+with no effort field/i,
  )?.[1];
  const thinking = source.match(/thinking lanes use\s+\x60([^\x60]+)\x60/i)?.[1];
  const mapping = source.match(
    /(?:中\/高\/极高|medium\/high\/(?:extra high|xhigh))[^\x60\n]*\x60([^\x60]+)\x60\s*\+\s*\x60standard\x60\/\x60extended\x60\/\x60max\x60/i,
  );
  const pro = source.match(/Pro lane moved to[^\x60\n]*\x60([^\x60]+)\x60/i)?.[1];
  if (!instant || !thinking || !mapping || !pro || mapping[1] !== thinking) {
    throw new Error('CHAT_UPSTREAM_FORMAT_INCOMPLETE');
  }
  const profiles = [
    buildProfile('CHAT', {
      signalReasoning: 'instant',
      request: { model: instant },
    }),
    buildProfile('CHAT', {
      signalReasoning: 'medium',
      request: { model: thinking, thinking_effort: 'standard' },
    }),
    buildProfile('CHAT', {
      signalReasoning: 'high',
      request: { model: thinking, thinking_effort: 'extended' },
    }),
    buildProfile('CHAT', {
      signalReasoning: 'xhigh',
      request: { model: thinking, thinking_effort: 'max' },
    }),
    buildProfile('CHAT', {
      signalReasoning: modelSignal(pro),
      request: { model: pro, thinking_effort: 'standard' },
    }),
  ];
  return { identity: identityOf(source, 'rosetta'), profiles };
}

export function parseWorkCatalogSnapshot(raw, activationSlugs = null) {
  const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const records = catalogRecords(payload).filter((record) => {
    const slug = String(record?.slug ?? record?.model_slug ?? record?.model ?? '');
    return slug.endsWith('-wm')
      && record?.enabled !== false
      && record?.disabled !== true
      && record?.is_work_mode_model !== false;
  });
  if (records.length === 0) throw new Error('WORK_CATALOG_EMPTY');

  const activation = activationSlugs ? new Set(activationSlugs) : null;
  const profiles = [];
  const seenModels = new Set();
  for (const record of records) {
    const slug = String(record?.slug ?? record?.model_slug ?? record?.model ?? '');
    if (activation && !activation.has(slug)) continue;
    const efforts = effortValues(record);
    if (efforts.length === 0) throw new Error('WORK_EFFORTS_REQUIRED:' + slug);
    const defaults = workRequestDefaults(record);
    seenModels.add(slug);
    for (const effort of efforts) {
      profiles.push(buildProfile('WORK', {
        signalModel: modelSignal(slug),
        signalReasoning: EFFORT_SIGNAL[effort],
        request: {
          model: slug,
          thinking_effort: effort,
          ...defaults,
        },
      }));
    }
  }

  if (activation) {
    const missing = [...activation].filter((slug) => !seenModels.has(slug));
    if (missing.length) {
      throw new Error('WORK_EFFORT_COVERAGE_INCOMPLETE:' + missing.sort().join(','));
    }
  }
  return {
    identity: identityOf(JSON.stringify(payload), 'work-catalog'),
    profiles,
  };
}

export function parseWorkActivationSlugs(raw) {
  const source = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const slugs = unique(source.match(/gpt-[0-9][a-z0-9.-]*-wm/g) || []).sort();
  if (slugs.length === 0) throw new Error('WORK_ACTIVATION_SNAPSHOT_EMPTY');
  return slugs;
}

export class HttpTrackedSource {
  constructor({ url, parser, fetchImpl = fetch, headers = {} }) {
    this.url = url;
    this.parser = parser;
    this.fetchImpl = fetchImpl;
    this.headers = headers;
  }

  async probe() {
    const response = await this.fetchImpl(this.url, {
      method: 'HEAD',
      headers: this.headers,
    });
    if (!response.ok) throw new Error('UPSTREAM_PROBE_FAILED:' + response.status);
    const identity = response.headers.get('etag') || response.headers.get('last-modified');
    return { identity: identity ? String(identity) : null };
  }

  async fetch(probed = null) {
    const response = await this.fetchImpl(this.url, {
      headers: { ...this.headers, 'cache-control': 'no-cache' },
    });
    const raw = await response.text();
    if (!response.ok) throw new Error('UPSTREAM_FETCH_FAILED:' + response.status);
    const parsed = this.parser(raw);
    return {
      ...parsed,
      identity: probed?.identity || parsed.identity || identityOf(raw),
    };
  }
}

function markdownCodeCell(cell) {
  const match = String(cell || '').match(/\`([^\`]+)\`/);
  return match ? match[1].trim() : '';
}

function normalizedModelLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function parseWorkHarCatalogMarkdown(text) {
  const source = String(text || '');
  const start = source.indexOf('## Work 普通聊天');
  if (start < 0) throw new Error('WORK_HAR_SECTION_MISSING');
  const tail = source.slice(start);
  const end = tail.slice(1).search(/\n##\s+/);
  const section = end >= 0 ? tail.slice(0, end + 1) : tail;
  const records = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const title = markdownCodeCell(cells[0]);
    const slug = markdownCodeCell(cells[1]);
    if (!slug.endsWith('-wm')) continue;
    const efforts = unique(
      cells[2].split('/').map((value) => value.trim().toLowerCase())
        .filter((value) => EFFORT_SIGNAL[value]),
    );
    if (!title || efforts.length === 0) {
      throw new Error('WORK_HAR_ROW_INCOMPLETE:' + slug);
    }
    records.push({
      slug,
      title,
      is_work_mode_model: true,
      enabled: true,
      conversation_origin: 'tpp',
      service_tier: 'standard',
      thinking_efforts: efforts.map((thinking_effort) => ({ thinking_effort })),
    });
  }
  if (records.length === 0) throw new Error('WORK_HAR_CATALOG_EMPTY');
  return { identity: identityOf(section, 'work-har'), records };
}
export function parseProdexWorkActivationLabels(text) {
  const source = String(text || '');
  const match = source.match(
    /Work offers\s+([^\n]+?)\s+with a\s+(?:[a-z]+|\d+)-step slider/i,
  );
  if (!match) throw new Error('WORK_ACTIVATION_LABELS_MISSING');
  const labels = unique(
    match[1].split(/\s*\/\s*/).map((value) => value.trim())
      .filter((value) => value && !/^default$/i.test(value)),
  );
  if (labels.length === 0) throw new Error('WORK_ACTIVATION_LABELS_EMPTY');
  return labels;
}

export function resolveWorkActivationSlugs(labels, records) {
  const out = [];
  for (const label of labels) {
    const key = normalizedModelLabel(label);
    const candidates = records.filter((record) => {
      const title = normalizedModelLabel(record?.title);
      const slug = normalizedModelLabel(record?.slug?.replace(/-wm$/, ''));
      return title === key || slug === key || title.endsWith(key) || slug.endsWith(key);
    });
    if (candidates.length !== 1) {
      throw new Error(
        'WORK_ACTIVATION_MODEL_AMBIGUOUS:' + label + ':' + candidates.length,
      );
    }
    out.push(String(candidates[0].slug));
  }
  return unique(out).sort();
}

export class WorkEvidenceTrackedSource {
  constructor({ catalogUrl, activationUrl, fetchImpl = fetch, headers = {} }) {
    this.catalogUrl = catalogUrl;
    this.activationUrl = activationUrl;
    this.fetchImpl = fetchImpl;
    this.headers = headers;
  }

  async probe() {
    const identities = [];
    for (const url of [this.catalogUrl, this.activationUrl]) {
      const response = await this.fetchImpl(url, { method: 'HEAD', headers: this.headers });
      if (!response.ok) throw new Error('UPSTREAM_PROBE_FAILED:' + response.status);
      identities.push(
        response.headers.get('etag') || response.headers.get('last-modified') || '',
      );
    }
    return {
      identity: identities.every(Boolean)
        ? identityOf(identities.join('\0'), 'work-evidence-head')
        : null,
    };
  }
  async fetch(probed = null) {
    const responses = await Promise.all(
      [this.catalogUrl, this.activationUrl].map((url) => this.fetchImpl(url, {
        headers: { ...this.headers, 'cache-control': 'no-cache' },
      })),
    );
    if (!responses[0].ok) {
      throw new Error('WORK_CATALOG_FETCH_FAILED:' + responses[0].status);
    }
    if (!responses[1].ok) {
      throw new Error('WORK_ACTIVATION_FETCH_FAILED:' + responses[1].status);
    }
    const [catalogRaw, activationRaw] = await Promise.all(
      responses.map((response) => response.text()),
    );
    const catalog = parseWorkHarCatalogMarkdown(catalogRaw);
    const labels = parseProdexWorkActivationLabels(activationRaw);
    const activationSlugs = resolveWorkActivationSlugs(labels, catalog.records);
    const parsed = parseWorkCatalogSnapshot({ models: catalog.records }, activationSlugs);
    const combined = catalogRaw + '\n---activation---\n' + activationRaw;
    return {
      ...parsed,
      identity: probed?.identity || identityOf(combined, 'work-evidence'),
      activation_slugs: activationSlugs,
    };
  }
}

// Codex catalog facts are discovery evidence only. They are never Work requests.
export function normalizeCodexModelDiscoveries(models) {
  if (!Array.isArray(models) || !models.length || models.length > 1000) {
    throw new Error('CODEX_DISCOVERY_MODELS_INVALID');
  }
  const seen = new Set();
  return models.map((model) => {
    const slug = model?.slug;
    const name = model?.display_name;
    const efforts = model?.reasoning_efforts;
    const defaultEffort = model?.default_reasoning_effort;
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,99}$/.test(slug)
        || typeof name !== 'string' || !name.trim() || name.length > 160
        || /[\x00-\x1f\x7f]/.test(name)
        || !Array.isArray(efforts) || !efforts.length || efforts.length > 24
        || efforts.some((effort) => typeof effort !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(effort))
        || new Set(efforts).size !== efforts.length || !efforts.includes(defaultEffort)
        || seen.has(slug)) {
      throw new Error('CODEX_DISCOVERY_RECORD_INVALID');
    }
    seen.add(slug);
    return {
      slug,
      display_name: name,
      reasoning_efforts: [...efforts],
      default_reasoning_effort: defaultEffort,
    };
  }).sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

export function parseCodexModelDiscovery(raw) {
  let payload = raw;
  if (typeof raw === 'string') {
    try { payload = JSON.parse(raw); }
    catch { throw new Error('CODEX_DISCOVERY_JSON_INVALID'); }
  }
  if (!Array.isArray(payload?.models)) throw new Error('CODEX_DISCOVERY_CATALOG_INVALID');
  const models = normalizeCodexModelDiscoveries(payload.models
    .filter((model) => model?.visibility === 'list')
    .map((model) => ({
      slug: model.slug,
      display_name: model.display_name,
      reasoning_efforts: Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels.map((level) => level?.effort) : null,
      default_reasoning_effort: model.default_reasoning_level,
    })));
  return { identity: identityOf(JSON.stringify(models), 'codex-discovery'), models };
}
