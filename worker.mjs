import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { detectCapabilities } from './capabilities.mjs';
import { renderProgramInventoryMarkdown } from './program-catalog.mjs';
import { runProfileSyncOnce } from './profile-sync-runtime.mjs';
import { ProfileSyncCoordinator } from './profile-sync-coordination.mjs';
import { recoverOwnedCatalogTab } from './profile-chat-collector.mjs';
import { SharedGoogleAuthClient } from './shared-google-auth-client.mjs';
import { inventoryArtifacts, publishInventoryArtifacts, remoteArtifactMatches } from './inventory-publication.mjs';
import { classifyCommandAdmission, loadResumeFence } from './sleep-command-cutoff.mjs';

import { UsageDriveStore, publishUsage, renderIndex, mergeManaged } from './mcp-usage-docs.mjs';

const VERSION = '0.2.18-dev10';
const HOME = os.homedir();
const SERVER_NAME_FILE = process.env.DRIVE_WORKER_SERVER_NAME_FILE || path.join(HOME, 'SERVER_NAME');
const SERVER_PRIORITY_FILE = process.env.DRIVE_WORKER_SERVER_PRIORITY_FILE || path.join(HOME, 'SERVER_PRIORITY');
const PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
const DATA = process.env.DRIVE_WORKER_DATA || path.join(HOME, '.drive-worker');
const COMMANDS_FOLDER_ID = process.env.DRIVE_WORKER_COMMANDS_FOLDER_ID;
const RESULTS_FOLDER_ID = process.env.DRIVE_WORKER_RESULTS_FOLDER_ID;
const STATE_FOLDER_ID = process.env.DRIVE_WORKER_STATE_FOLDER_ID;
const SKILLS_FOLDER_ID = process.env.DRIVE_WORKER_SKILLS_FOLDER_ID || '';
const MCP_FOLDER_ID = process.env.DRIVE_WORKER_MCP_FOLDER_ID || '1quTFH6MVP4hbTPQ70HUGaX9zU-MdL5gW';
const TOKEN_FILE = process.env.DRIVE_WORKER_OAUTH_TOKEN_FILE
  || path.join(HOME, '.selfrun-server', 'drive-auth-token.json');
const POLL_MS = Number(process.env.DRIVE_WORKER_POLL_MS || 5000);
const CONFIGURED_MAX_CONCURRENCY = Number(process.env.DRIVE_WORKER_MAX_CONCURRENCY || 0);
const AUTO_CONCURRENCY_MIN = Math.max(1, Number(process.env.DRIVE_WORKER_AUTO_MIN_CONCURRENCY || 1));
const AUTO_CONCURRENCY_BASE = Math.max(
  AUTO_CONCURRENCY_MIN,
  Number(process.env.DRIVE_WORKER_AUTO_BASE_CONCURRENCY || 6),
);
const AUTO_CONCURRENCY_MAX = Math.max(
  AUTO_CONCURRENCY_BASE,
  Number(process.env.DRIVE_WORKER_AUTO_MAX_CONCURRENCY || 12),
);
const AUTO_MEMORY_RESERVE_MB = Math.max(
  256,
  Number(process.env.DRIVE_WORKER_AUTO_MEMORY_RESERVE_MB || 1024),
);
const AUTO_MEMORY_PER_JOB_MB = Math.max(
  128,
  Number(process.env.DRIVE_WORKER_AUTO_MEMORY_PER_JOB_MB || 512),
);
const CPU_SAMPLE_MS = Math.max(
  2000,
  Number(process.env.DRIVE_WORKER_CPU_SAMPLE_MS || 5000),
);
const CPU_SAMPLE_TIMEOUT_MS = Math.max(
  2000,
  Number(process.env.DRIVE_WORKER_CPU_SAMPLE_TIMEOUT_MS || 4000),
);
const HEARTBEAT_MS = Number(process.env.DRIVE_WORKER_HEARTBEAT_MS || 30000);
const CLUSTER_MEMBER_TIMEOUT_MS = Math.max(
  HEARTBEAT_MS * 2,
  Number(process.env.DRIVE_WORKER_CLUSTER_MEMBER_TIMEOUT_MS || 65000),
);
const CLUSTER_SETTLE_MS = Math.max(
  POLL_MS * 2,
  Number(process.env.DRIVE_WORKER_CLUSTER_SETTLE_MS || 10000),
);
const HEALTH_PORT = Number(process.env.DRIVE_WORKER_HEALTH_PORT || 17841);
const CAPABILITIES_REFRESH_MS = Number(process.env.DRIVE_WORKER_CAPABILITIES_REFRESH_MS || 300000);
const PROFILE_SYNC_REFRESH_MS = Math.max(3600000, Number(process.env.DRIVE_WORKER_PROFILE_SYNC_REFRESH_MS || 3600000));
const CLEANUP_INTERVAL_MS = Number(process.env.DRIVE_WORKER_CLEANUP_INTERVAL_MS || 3600000);
const CLEANUP_DONE_DETAIL_RETENTION_MS = Number(
  process.env.DRIVE_WORKER_CLEANUP_DONE_DETAIL_RETENTION_MS || 2592000000,
);
const CLEANUP_FAILURE_RETENTION_MS = Number(
  process.env.DRIVE_WORKER_CLEANUP_FAILURE_RETENTION_MS || 7776000000,
);
const CLEANUP_ORPHAN_RETENTION_MS = Number(
  process.env.DRIVE_WORKER_CLEANUP_ORPHAN_RETENTION_MS || 7776000000,
);
const TERMINAL_RESULT_STATUSES = new Set(['DONE', 'FAILED', 'ERROR', 'TIMED_OUT', 'INVALID']);
const HTTP_TIMEOUT_MS = Number(process.env.DRIVE_WORKER_HTTP_TIMEOUT_MS || 15000);
const HTTP_RETRY_COUNT = Number(process.env.DRIVE_WORKER_HTTP_RETRY_COUNT || 2);
const SKILL_INDEX_MD = 'SKILL_INDEX.md';
const SKILL_INDEX_JSON = 'SKILL_INDEX.json';
const SKILL_SYNC_MANIFEST = 'SKILL_SYNC_MANIFEST.json';
const SKILL_MANAGED_MARKER = '.drive-worker-managed.json';
const OUTBOUND_PRIVATE_MARKERS_FILE = path.join(DATA, 'outbound-private-markers.txt');

function outboundPrivateMarkers() {
  try {
    return fss.readFileSync(OUTBOUND_PRIVATE_MARKERS_FILE, 'utf8')
      .split(/\r?\n/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function containsOutboundPrivate(value, markers = outboundPrivateMarkers()) {
  const text = String(value ?? '').toLowerCase();
  return markers.some((marker) => text.includes(marker));
}

const OUTBOUND_OMIT = Symbol('outbound-omit');
function sanitizeOutboundValue(value, markers = outboundPrivateMarkers()) {
  if (typeof value === 'string') {
    return containsOutboundPrivate(value, markers) ? OUTBOUND_OMIT : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOutboundValue(item, markers)).filter((item) => item !== OUTBOUND_OMIT);
  }
  if (value && typeof value === 'object') {
    for (const direct of Object.values(value)) {
      if (typeof direct === 'string' && containsOutboundPrivate(direct, markers)) return OUTBOUND_OMIT;
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (containsOutboundPrivate(key, markers)) continue;
      const clean = sanitizeOutboundValue(item, markers);
      if (clean !== OUTBOUND_OMIT) out[key] = clean;
    }
    return out;
  }
  return value;
}

function sanitizeOutboundText(value) {
  const text = String(value ?? '');
  const markers = outboundPrivateMarkers();
  if (!markers.length || !text) return text;
  try {
    const parsed = JSON.parse(text);
    const clean = sanitizeOutboundValue(parsed, markers);
    return clean === OUTBOUND_OMIT ? '' : JSON.stringify(clean, null, text.includes('\n') ? 2 : 0) + (text.endsWith('\n') ? '\n' : '');
  } catch {}
  const trailing = text.endsWith('\n');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) { out.push(line); continue; }
    try {
      const parsed = JSON.parse(line);
      const clean = sanitizeOutboundValue(parsed, markers);
      if (clean !== OUTBOUND_OMIT) out.push(JSON.stringify(clean));
    } catch {
      if (!containsOutboundPrivate(line, markers)) out.push(line);
    }
  }
  let result = out.join('\n');
  if (trailing && !result.endsWith('\n')) result += '\n';
  return result;
}
const MCP_INDEX_MD = 'MCP_INDEX.md';
const MCP_INDEX_JSON = 'MCP_INDEX.json';
const MCP_SYNC_MANIFEST = 'MCP_SYNC_MANIFEST.json';
const MCP_INVENTORY_JSON = path.join(HOME, 'MCP_INVENTORY.json');
const MCP_INVENTORY_MD = path.join(HOME, 'MCP_INVENTORY.md');
const CAPABILITIES_FILE = path.join(DATA, 'capabilities.json');
const TERMUX_CAPABILITIES_JSON = path.join(HOME, 'TERMUX_CAPABILITIES.json');
const TERMUX_CAPABILITIES_MD = path.join(HOME, 'TERMUX_CAPABILITIES.md');
const RDC_CAPABILITIES_JSON = path.join(HOME, 'RDC_CAPABILITIES.json');
const RDC_CAPABILITIES_MD = path.join(HOME, 'RDC_CAPABILITIES.md');
const DEFAULT_SHELL = process.env.DRIVE_WORKER_SHELL || path.join(PREFIX, 'bin', 'bash');
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serverName() {
  try {
    const value = fss.readFileSync(SERVER_NAME_FILE, 'utf8').trim();
    if (value) return value;
  } catch {}
  return os.hostname();
}

function serverPriority() {
  const envValue = Number(process.env.DRIVE_WORKER_SERVER_PRIORITY || '');
  if (Number.isFinite(envValue) && envValue > 0) return Math.floor(envValue);
  try {
    const value = Number(fss.readFileSync(SERVER_PRIORITY_FILE, 'utf8').trim());
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  } catch {}
  const name = serverName();
  if (name === 'Galaxy-Tab-S11-Ultra') return 1;
  if (name === 'Galaxy-S25') return 2;
  return 100;
}

function safeServerKey(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function memberStateFileName(name = serverName()) {
  return `worker-${safeServerKey(name)}.json`;
}

function stateTimestampMs(state) {
  const value = Date.parse(String(state?.updated_at || state?.heartbeat_at || ''));
  return Number.isFinite(value) ? value : 0;
}

function isMemberFresh(state, now = Date.now()) {
  if (!state) return false;
  if (String(state.status || '').toUpperCase() === 'STOPPING') return false;
  const updated = stateTimestampMs(state);
  return updated > 0 && now - updated <= CLUSTER_MEMBER_TIMEOUT_MS;
}

const clusterRuntime = {
  role: 'CANDIDATE',
  activeServer: null,
  activePriority: null,
  members: {},
  settleUntil: Date.now() + CLUSTER_SETTLE_MS,
  lastElectionAt: null,
  lastTransitionAt: null,
  claimReadyAt: Date.now() + CLUSTER_SETTLE_MS,
};

function memberIsAlive(name) {
  if (!name) return false;
  if (name === serverName()) return true;
  return isMemberFresh(clusterRuntime.members?.[name]);
}

function canClaimCommands(now = Date.now()) {
  return !shuttingDown && clusterRuntime.role === 'ACTIVE'
    && now >= Number(clusterRuntime.claimReadyAt || 0);
}

function commandTargetServer(job) {
  return String(job?.target_server || '').trim();
}

function standbyOverflowCandidate(now = Date.now()) {
  return Object.values(clusterRuntime.members || {})
    .filter((state) => isMemberFresh(state, now) && !state.drain?.requested)
    .map((state) => ({
      name: String(state.server_name || state.host || '').trim(),
      priority: Number(state.server_priority || 100),
      role: String(state.role || '').toUpperCase(),
      activeCount: Array.isArray(state.active_jobs)
        ? state.active_jobs.length
        : state.active_job ? 1 : 0,
      capacity: Math.max(1, Number(state.max_concurrency || state.concurrency?.effective || 1)),
    }))
    .filter((entry) => entry.name && entry.name !== serverName())
    .filter((entry) => entry.role === 'STANDBY')
    .filter((entry) => entry.activeCount < entry.capacity)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))[0] || null;
}

if (!COMMANDS_FOLDER_ID || !RESULTS_FOLDER_ID || !STATE_FOLDER_ID) {
  throw new Error('Drive Worker folder IDs are required');
}

await fs.mkdir(DATA, { recursive: true });
await fs.mkdir(path.join(DATA, 'jobs'), { recursive: true });

class DriveClient {
  static authStatuses = Object.freeze({
    AUTH_SERVICE_UNAVAILABLE: 'service_unavailable',
    AUTH_NOT_READY: 'not_ready',
    AUTH_REAUTH_REQUIRED: 'reauth_required',
    AUTH_TEMPORARY_UNAVAILABLE: 'temporary_unavailable',
    AUTH_INTERNAL_ERROR: 'internal_error',
  });

  constructor(auth) {
    this.auth = auth;
    this.authState = { ready: false, status: 'not_ready' };
  }

  authSnapshot() {
    return { ...this.authState };
  }

  async accessToken(force = false, rejectedAccessToken) {
    try {
      const token = force
        ? await this.auth.forceRefresh(rejectedAccessToken)
        : await this.auth.accessToken(false);
      this.authState = { ready: true, status: 'ready' };
      return token;
    } catch (error) {
      const status = Object.hasOwn(DriveClient.authStatuses, error?.code)
        ? DriveClient.authStatuses[error.code] : 'internal_error';
      this.authState = { ready: false, status };
      throw error;
    }
  }

  async request(url, init = {}, authRetry = true, transientRetries = HTTP_RETRY_COUNT) {
    const access = await this.accessToken();
    let response;
    try {
      response = await fetch(url, {
        ...init,
        signal: init.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: { ...(init.headers || {}), authorization: 'Bearer ' + access },
      });
    } catch (error) {
      if (transientRetries > 0) {
        return this.request(url, init, authRetry, transientRetries - 1);
      }
      throw error;
    }
    if (response.status === 401) {
      this.authState = { ready: false, status: 'access_rejected' };
      if (authRetry) {
        try { await response.arrayBuffer(); } catch {}
        await this.accessToken(true, access);
        return this.request(url, init, false, transientRetries);
      }
    }
    if ((response.status === 429 || response.status >= 500) && transientRetries > 0) {
      try { await response.arrayBuffer(); } catch {}
      return this.request(url, init, authRetry, transientRetries - 1);
    }
    return response;
  }

  async listFolder(folderId) {
    const q = "'" + folderId + "' in parents and trashed=false";
    const files = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q,
        spaces: 'drive',
        fields: 'nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,appProperties,size,webViewLink)',
        pageSize: '1000',
        orderBy: 'modifiedTime',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await this.request(API + '/files?' + params);
      const raw = await response.text();
      if (!response.ok) {
        throw new Error('Drive list failed: ' + response.status + ' ' + raw.slice(0, 300));
      }
      const payload = JSON.parse(raw || '{}');
      files.push(...(payload.files || []));
      pageToken = String(payload.nextPageToken || '');
    } while (pageToken);
    return files.sort(
      (a, b) => String(a.modifiedTime || '').localeCompare(String(b.modifiedTime || ''))
    );
  }

  async getMetadata(fileId) {
    const response = await this.request(
      API + '/files/' + encodeURIComponent(fileId) + '?' + new URLSearchParams({
        fields: 'id,name,mimeType,createdTime,modifiedTime,appProperties,parents,trashed',
      }),
    );
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive metadata failed: ' + response.status + ' ' + raw.slice(0, 300));
    return JSON.parse(raw || '{}');
  }

  async readText(file) {
    const id = String(file.id || '');
    const isDoc = file.mimeType === 'application/vnd.google-apps.document';
    const url = isDoc
      ? API + '/files/' + encodeURIComponent(id) + '/export?'
        + new URLSearchParams({ mimeType: 'text/plain' })
      : API + '/files/' + encodeURIComponent(id) + '?alt=media';
    const response = await this.request(url);
    const text = await response.text();
    if (!response.ok) throw new Error('Drive read failed: ' + response.status + ' ' + text.slice(0, 300));
    return text.replace(/^\uFEFF/, '');
  }

  async createBytes(folderId, name, mimeType, bytes) {
    const metadata = { name, parents: [folderId] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([bytes], { type: mimeType }), name);
    const response = await this.request(
      UPLOAD + '/files?uploadType=multipart&fields=id,name,mimeType,webViewLink',
      { method: 'POST', body: form },
    );
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive create failed: ' + response.status + ' ' + raw.slice(0, 300));
    return JSON.parse(raw || '{}');
  }

  async updateBytes(fileId, mimeType, bytes) {
    const response = await this.request(
      UPLOAD + '/files/' + encodeURIComponent(fileId) + '?uploadType=media',
      { method: 'PATCH', headers: { 'content-type': mimeType }, body: bytes },
    );
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive update failed: ' + response.status + ' ' + raw.slice(0, 300));
    return raw ? JSON.parse(raw) : { id: fileId };
  }

  async findByName(folderId, name) {
    const esc = String(name).replace(/'/g, "\\'");
    const q = "'" + folderId + "' in parents and trashed=false and name='" + esc + "'";
    const url = API + '/files?' + new URLSearchParams({
      q,
      spaces: 'drive',
      fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
      pageSize: '10',
    });
    const response = await this.request(url);
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive find failed: ' + response.status + ' ' + raw.slice(0, 300));
    return (JSON.parse(raw || '{}').files || [])[0] || null;
  }

  async upsertJson(folderId, name, value) {
    const text = JSON.stringify(value, null, 2) + '\n';
    const found = await this.findByName(folderId, name);
    if (found) {
      await this.updateBytes(found.id, 'application/json; charset=utf-8', text);
      return { ...found, id: found.id };
    }
    return this.createBytes(folderId, name, 'application/json; charset=utf-8', text);
  }

  async uploadText(folderId, name, text, mimeType = 'text/plain; charset=utf-8') {
    const found = await this.findByName(folderId, name);
    if (found) {
      await this.updateBytes(found.id, mimeType, text);
      return { ...found, id: found.id };
    }
    return this.createBytes(folderId, name, mimeType, text);
  }

  async createFolder(folderId, name) {
    const metadata = { name, mimeType: 'application/vnd.google-apps.folder', parents: [folderId] };
    const response = await this.request(
      API + '/files?fields=id,name,mimeType,webViewLink',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(metadata),
      },
    );
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive folder create failed: ' + response.status + ' ' + raw.slice(0, 300));
    return JSON.parse(raw || '{}');
  }

  async trashFile(fileId) {
    const response = await this.request(
      API + '/files/' + encodeURIComponent(fileId) + '?fields=id,trashed',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ trashed: true }),
      },
    );
    const raw = await response.text();
    if (!response.ok) throw new Error('Drive trash failed: ' + response.status + ' ' + raw.slice(0, 300));
    return raw ? JSON.parse(raw) : { id: fileId, trashed: true };
  }
}

const auth = new SharedGoogleAuthClient({ tokenFile: TOKEN_FILE });
const drive = new DriveClient(auth);
const runtime = {
  startedAt: new Date().toISOString(),
  activeJobs: new Map(),
  lastPollAt: null,
  lastSuccessAt: null,
  lastError: null,
  processed: 0,
  currentChildren: new Map(),
  cpuSample: {
    source: process.platform === 'android' ? 'termux_top_processes' : 'load_average',
    usage_pct: null,
    process_cpu_sum_pct: null,
    process_count: null,
    sampled_at: null,
    error: null,
  },
  cpuSampleRunning: false,
  capabilities: null,
  lastCapabilitiesAt: null,
  lastCapabilitiesError: null,
  skillSync: null,
  lastSkillSyncError: null,
  mcpSync: null,
  lastMcpSyncError: null,
  profileSync: null,
  lastProfileSyncError: null,
  profileSyncRunning: false,
  nextProfileSyncAt: 0,
  cleanup: {
    last_run_at: null,
    last_success_at: null,
    last_error: null,
    last_stats: null,
    total_runs: 0,
    total_drive_trashed: 0,
    total_local_jobs_removed: 0,
  },
};

function activeJobsSnapshot() {
  return Array.from(runtime.activeJobs.values());
}

function firstActiveJob() {
  return activeJobsSnapshot()[0] || null;
}

function memoryAvailableMb() {
  try {
    const meminfo = fss.readFileSync('/proc/meminfo', 'utf8');
    const line = meminfo.split(String.fromCharCode(10))
      .find((item) => item.startsWith('MemAvailable:'));
    if (line) {
      const parts = line.trim().split(/\s+/);
      const kb = Number(parts[1] || 0);
      if (Number.isFinite(kb) && kb > 0) return kb / 1024;
    }
  } catch {}
  return os.freemem() / (1024 * 1024);
}

function parseAndroidTopCpuSample(output, cpuCount) {
  const text = String(output || '');
  const marker = text.lastIndexOf(String.fromCharCode(10) + 'Tasks:');
  const section = marker >= 0 ? text.slice(marker + 1) : text;
  let processCpuSum = 0;
  let processCount = 0;
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\s+([0-9]+(?:\.[0-9]+)?)\b/);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    processCpuSum += value;
    processCount += 1;
  }
  if (!processCount) throw new Error('top process CPU sample contained no process rows');
  const usagePct = Math.max(0, Math.min(100, processCpuSum / Math.max(1, cpuCount)));
  return { usagePct, processCpuSum, processCount };
}

async function sampleAndroidTermuxCpu(cpuCount) {
  return await new Promise((resolve, reject) => {
    const child = spawn('top', ['-b', '-d', '1', '-n', '2', '-m', '500', '-o', 'PID,%CPU'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('top CPU sample timed out'));
    }, CPU_SAMPLE_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 262144) stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 32768) stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('top CPU sample failed: ' + String(code ?? signal ?? 'unknown') + ' ' + stderr.slice(-300)));
        return;
      }
      try {
        resolve(parseAndroidTopCpuSample(stdout, cpuCount));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function refreshCpuUsageSample() {
  if (shuttingDown) return Promise.resolve(null);
  return trackOperation(refreshCpuUsageSampleWork(), 'refreshCpuUsageSample');
}

async function refreshCpuUsageSampleWork() {
  if (process.platform !== 'android' || runtime.cpuSampleRunning) return;
  runtime.cpuSampleRunning = true;
  try {
    const cpuCount = Math.max(1, Number(os.availableParallelism?.() || os.cpus()?.length || 1));
    const sample = await sampleAndroidTermuxCpu(cpuCount);
    runtime.cpuSample = {
      source: 'termux_top_processes',
      usage_pct: Number(sample.usagePct.toFixed(2)),
      process_cpu_sum_pct: Number(sample.processCpuSum.toFixed(2)),
      process_count: sample.processCount,
      sampled_at: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    runtime.cpuSample = {
      ...runtime.cpuSample,
      sampled_at: runtime.cpuSample?.sampled_at || null,
      error: String(error?.message || error).slice(0, 500),
    };
  } finally {
    runtime.cpuSampleRunning = false;
  }
}

function freshAndroidCpuUsagePct() {
  if (process.platform !== 'android') return null;
  const value = Number(runtime.cpuSample?.usage_pct);
  const sampledAt = Date.parse(runtime.cpuSample?.sampled_at || '');
  const maxAge = Math.max(15000, CPU_SAMPLE_MS * 3);
  if (!Number.isFinite(value) || !Number.isFinite(sampledAt) || Date.now() - sampledAt > maxAge) {
    return null;
  }
  return value;
}

function concurrencySnapshot() {
  const cpuCount = Math.max(1, Number(os.availableParallelism?.() || os.cpus()?.length || 1));
  const load1 = Number(os.loadavg()?.[0] || 0);
  const loadPerCpu = load1 / cpuCount;
  const memoryAvailable = memoryAvailableMb();
  const androidCpuUsagePct = freshAndroidCpuUsagePct();
  const cpuMetric = process.platform === 'android' ? 'termux_process_cpu' : 'load_average';

  if (Number.isFinite(CONFIGURED_MAX_CONCURRENCY) && CONFIGURED_MAX_CONCURRENCY > 0) {
    const effective = Math.max(1, Math.floor(CONFIGURED_MAX_CONCURRENCY));
    return {
      mode: 'fixed',
      effective,
      configured_max: effective,
      auto_min: AUTO_CONCURRENCY_MIN,
      auto_base: AUTO_CONCURRENCY_BASE,
      auto_max: AUTO_CONCURRENCY_MAX,
      cpu_count: cpuCount,
      cpu_metric: cpuMetric,
      cpu_usage_pct: androidCpuUsagePct,
      cpu_process_sum_pct: runtime.cpuSample?.process_cpu_sum_pct ?? null,
      cpu_sample_at: runtime.cpuSample?.sampled_at ?? null,
      cpu_sample_error: runtime.cpuSample?.error ?? null,
      load_1m: Number(load1.toFixed(2)),
      load_per_cpu: Number(loadPerCpu.toFixed(3)),
      memory_available_mb: Math.round(memoryAvailable),
      memory_limit: null,
      cpu_limit: null,
    };
  }

  const memoryLimit = Math.max(
    AUTO_CONCURRENCY_MIN,
    Math.floor(Math.max(0, memoryAvailable - AUTO_MEMORY_RESERVE_MB) / AUTO_MEMORY_PER_JOB_MB),
  );

  let cpuLimit = AUTO_CONCURRENCY_BASE;
  if (process.platform === 'android') {
    if (androidCpuUsagePct == null) {
      cpuLimit = AUTO_CONCURRENCY_BASE;
    } else if (androidCpuUsagePct < 35) {
      cpuLimit = AUTO_CONCURRENCY_MAX;
    } else if (androidCpuUsagePct < 55) {
      cpuLimit = Math.min(AUTO_CONCURRENCY_MAX, AUTO_CONCURRENCY_BASE + 2);
    } else if (androidCpuUsagePct < 70) {
      cpuLimit = AUTO_CONCURRENCY_BASE;
    } else if (androidCpuUsagePct < 85) {
      cpuLimit = Math.max(AUTO_CONCURRENCY_MIN, Math.ceil(AUTO_CONCURRENCY_BASE / 2));
    } else {
      cpuLimit = AUTO_CONCURRENCY_MIN;
    }
  } else if (loadPerCpu < 0.75) {
    cpuLimit = AUTO_CONCURRENCY_MAX;
  } else if (loadPerCpu < 1.5) {
    cpuLimit = Math.min(AUTO_CONCURRENCY_MAX, AUTO_CONCURRENCY_BASE + 2);
  } else if (loadPerCpu < 2.5) {
    cpuLimit = AUTO_CONCURRENCY_BASE;
  } else if (loadPerCpu < 3.5) {
    cpuLimit = Math.max(AUTO_CONCURRENCY_MIN, Math.ceil(AUTO_CONCURRENCY_BASE / 2));
  } else {
    cpuLimit = AUTO_CONCURRENCY_MIN;
  }

  const effective = Math.max(
    AUTO_CONCURRENCY_MIN,
    Math.min(AUTO_CONCURRENCY_MAX, memoryLimit, cpuLimit),
  );

  return {
    mode: 'auto',
    effective,
    configured_max: 0,
    auto_min: AUTO_CONCURRENCY_MIN,
    auto_base: AUTO_CONCURRENCY_BASE,
    auto_max: AUTO_CONCURRENCY_MAX,
    cpu_count: cpuCount,
    cpu_metric: cpuMetric,
    cpu_usage_pct: androidCpuUsagePct,
    cpu_process_sum_pct: runtime.cpuSample?.process_cpu_sum_pct ?? null,
    cpu_sample_at: runtime.cpuSample?.sampled_at ?? null,
    cpu_sample_error: runtime.cpuSample?.error ?? null,
    load_1m: Number(load1.toFixed(2)),
    load_per_cpu: Number(loadPerCpu.toFixed(3)),
    memory_available_mb: Math.round(memoryAvailable),
    memory_limit: memoryLimit,
    cpu_limit: cpuLimit,
  };
}

function terminateChildTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {}
  try { child.kill(signal); } catch {}
}

async function recoverPreviousActiveResults() {
  const stateFile = await drive.findByName(STATE_FOLDER_ID, 'worker-state.json');
  if (!stateFile) return [];

  let previous;
  try {
    previous = JSON.parse(await drive.readText(stateFile));
  } catch {
    return [];
  }

  const jobIds = new Set();
  for (const item of previous?.active_jobs || []) {
    if (item?.job_id) jobIds.add(String(item.job_id));
  }
  if (previous?.active_job?.job_id) {
    jobIds.add(String(previous.active_job.job_id));
  }

  const recovered = [];
  const now = Date.now();

  for (const jobId of jobIds) {
    const resultFile = await drive.findByName(
      RESULTS_FOLDER_ID,
      safeJobName(jobId) + '.json',
    );
    if (!resultFile) continue;

    let result;
    try {
      result = JSON.parse(await drive.readText(resultFile));
    } catch {
      continue;
    }

    if (result?.status !== 'RUNNING' && result?.status !== 'CLAIMED') continue;

    const timeoutMs = Math.max(0, Number(result.timeout_ms || 0));
    const startedAt = Date.parse(String(result.started_at || result.claimed_at || ''));
    const timedOut = timeoutMs > 0
      && Number.isFinite(startedAt)
      && now - startedAt >= timeoutMs;

    const finalResult = {
      ...result,
      status: timedOut ? 'TIMED_OUT' : 'ERROR',
      timed_out: timedOut,
      completed_at: new Date().toISOString(),
      recovered_after_restart: true,
      error: timedOut
        ? 'stale RUNNING job recovered after worker restart; timeout elapsed'
        : 'job interrupted by worker restart',
    };

    await drive.updateBytes(
      resultFile.id,
      'application/json; charset=utf-8',
      JSON.stringify(finalResult, null, 2) + '\n',
    );
    recovered.push({ job_id: jobId, status: finalResult.status });
  }

  return recovered;
}

function safeJobName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.split('').map((ch) => {
    const ok = /[A-Za-z0-9._:-]/.test(ch);
    return ok ? ch : '_';
  }).join('').slice(0, 160);
}

async function tailFile(file, maxBytes = 32768) {
  try {
    const stat = await fs.stat(file);
    const size = Math.min(stat.size, maxBytes);
    if (size <= 0) return '';
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, stat.size - size);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

async function atomicWrite(file, text) {
  const temp = file + '.tmp-' + process.pid;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, file);
}


function hashText(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function parseSkillFrontmatter(text) {
  const lines = String(text || '').split(/\r?\n/);
  if ((lines[0] || '').trim() !== '---') return {};
  const parsed = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

async function readJsonDriveFile(folderId, name) {
  const file = await drive.findByName(folderId, name);
  if (!file) return null;
  try {
    return JSON.parse(await drive.readText(file));
  } catch {
    return null;
  }
}

async function verifyManagedSkillFolder(folderId, skillName) {
  const marker = await drive.findByName(folderId, SKILL_MANAGED_MARKER);
  if (!marker) return false;
  try {
    const body = JSON.parse(await drive.readText(marker));
    return body?.managed_by === 'drive-worker'
      && body?.skill_name === skillName
      && body?.root_folder_id === SKILLS_FOLDER_ID;
  } catch {
    return false;
  }
}

async function collectDriveSkillIndex() {
  const entries = [];
  const rootItems = await drive.listFolder(SKILLS_FOLDER_ID);
  const folders = rootItems.filter((item) => item.mimeType === 'application/vnd.google-apps.folder');
  for (const folder of folders) {
    const children = await drive.listFolder(folder.id);
    const skillFile = children.find((item) => item.name === 'SKILL.md');
    if (!skillFile) continue;
    let text = '';
    try {
      text = await drive.readText(skillFile);
    } catch {
      continue;
    }
    const meta = parseSkillFrontmatter(text);
    const markerFile = children.find((item) => item.name === SKILL_MANAGED_MARKER);
    let managed = false;
    let markerMeta = {};
    if (markerFile) {
      try {
        markerMeta = JSON.parse(await drive.readText(markerFile));
        managed = markerMeta?.managed_by === 'drive-worker';
      } catch {}
    }
    entries.push({
      name: String(meta.name || folder.name),
      description: meta.description || null,
      version: meta.version || null,
      source: meta.source || markerMeta.source || null,
      folder_name: folder.name,
      folder_id: folder.id,
      skill_file_id: skillFile.id,
      drive_path: '/GPT/Skills/' + folder.name + '/SKILL.md',
      managed_by_drive_worker: managed,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function renderSkillIndex(entries, generatedAt) {
  const lines = [
    '# SKILL_INDEX',
    '',
    '일반 ChatGPT용 스킬 라우팅 인덱스입니다.',
    '현재 요청과 description이 실질적으로 일치하는 스킬만 선택하고, 선택한 스킬의 SKILL.md만 읽어 적용합니다.',
    '관련 스킬이 없으면 추가 스킬을 읽지 않습니다. 여러 스킬이 서로 보완적일 때만 복수 선택합니다.',
    '',
    '- generated_at: ' + generatedAt,
    '- skill_count: ' + entries.length,
    '- root: /GPT/Skills/',
    '',
    '## Skills',
    '',
  ];
  for (const item of entries) {
    lines.push('### ' + item.name);
    lines.push('- description: ' + (item.description || '(none)'));
    if (item.version) lines.push('- version: ' + item.version);
    if (item.source) lines.push('- source: ' + item.source);
    lines.push('- drive_path: ' + item.drive_path);
    lines.push('- skill_file_id: ' + item.skill_file_id);
    lines.push('- managed_by_drive_worker: ' + String(item.managed_by_drive_worker));
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

async function syncSkillsToDrive(capabilities) {
  if (!SKILLS_FOLDER_ID) {
    runtime.skillSync = null;
    runtime.lastSkillSyncError = null;
    return null;
  }

  const startedAt = new Date().toISOString();
  const previous = await readJsonDriveFile(SKILLS_FOLDER_ID, SKILL_SYNC_MANIFEST) || {
    schema: 'drive-worker-skill-sync-manifest-v1',
    managed_skills: {},
  };
  const previousManaged = previous.managed_skills && typeof previous.managed_skills === 'object'
    ? previous.managed_skills
    : {};
  const rootItems = await drive.listFolder(SKILLS_FOLDER_ID);
  const rootFoldersByName = new Map(
    rootItems
      .filter((item) => item.mimeType === 'application/vnd.google-apps.folder')
      .map((item) => [item.name, item]),
  );

  const nextManaged = {};
  const conflicts = [];
  const installed = capabilities?.skills?.installed || [];

  for (const skill of installed) {
    const name = String(skill.name || '').trim();
    const localSkillFile = skill.locations?.[0]?.skill_file;
    if (!name || !localSkillFile) continue;

    const text = await fs.readFile(localSkillFile, 'utf8');
    const sha256 = hashText(text);
    const previousEntry = previousManaged[name] || null;
    let folder = previousEntry?.folder_id
      ? rootItems.find((item) => item.id === previousEntry.folder_id)
      : null;

    if (!folder) {
      const sameName = rootFoldersByName.get(name);
      if (sameName) {
        const isManaged = await verifyManagedSkillFolder(sameName.id, name);
        if (!isManaged) {
          conflicts.push({
            skill_name: name,
            reason: 'manual_folder_name_collision',
            folder_id: sameName.id,
          });
          continue;
        }
        folder = sameName;
      }
    }

    if (!folder) {
      folder = await drive.createFolder(SKILLS_FOLDER_ID, name);
      rootFoldersByName.set(name, folder);
    }

    let skillFile = null;
    if (previousEntry?.skill_file_id && previousEntry.sha256 === sha256) {
      skillFile = { id: previousEntry.skill_file_id, name: 'SKILL.md' };
    } else {
      skillFile = await drive.uploadText(
        folder.id,
        'SKILL.md',
        text,
        'text/markdown; charset=utf-8',
      );
    }

    const markerBody = {
      schema: 'drive-worker-managed-skill-v1',
      managed_by: 'drive-worker',
      root_folder_id: SKILLS_FOLDER_ID,
      skill_name: name,
      source: skill.source || null,
      source_url: skill.source_url || null,
      local_skill_file: localSkillFile,
      sha256,
      synced_at: startedAt,
    };
    const markerFile = await drive.uploadText(
      folder.id,
      SKILL_MANAGED_MARKER,
      JSON.stringify(markerBody, null, 2) + '\n',
      'application/json; charset=utf-8',
    );

    nextManaged[name] = {
      folder_id: folder.id,
      skill_file_id: skillFile.id,
      marker_file_id: markerFile.id,
      sha256,
      source: skill.source || null,
      source_url: skill.source_url || null,
      local_skill_file: localSkillFile,
    };
  }

  const removed = [];
  for (const [name, entry] of Object.entries(previousManaged)) {
    if (nextManaged[name] || installed.some((skill) => skill.name === name)) continue;
    if (!entry?.folder_id) continue;
    // This shared catalog spans devices with different local installations.
    // Local absence is not authorization to delete a shared managed skill.
    nextManaged[name] = entry;
  }

  const indexedSkills = await collectDriveSkillIndex();
  const generatedAt = new Date().toISOString();
  const indexMarkdown = renderSkillIndex(indexedSkills, generatedAt);
  const indexMdFile = await drive.uploadText(
    SKILLS_FOLDER_ID,
    SKILL_INDEX_MD,
    indexMarkdown,
    'text/markdown; charset=utf-8',
  );
  const indexJson = {
    schema: 'chatgpt-drive-skill-index-v1',
    generated_at: generatedAt,
    root_folder_id: SKILLS_FOLDER_ID,
    router: {
      select_by: 'description',
      read_only_selected_skill_files: true,
      allow_multiple_when_complementary: true,
      skip_when_no_relevant_skill: true,
    },
    skills: indexedSkills,
  };
  const indexJsonFile = await drive.uploadText(
    SKILLS_FOLDER_ID,
    SKILL_INDEX_JSON,
    JSON.stringify(indexJson, null, 2) + '\n',
    'application/json; charset=utf-8',
  );

  const manifest = {
    schema: 'drive-worker-skill-sync-manifest-v1',
    updated_at: generatedAt,
    root_folder_id: SKILLS_FOLDER_ID,
    managed_skills: nextManaged,
    removed,
    conflicts,
    index_md_file_id: indexMdFile.id,
    index_json_file_id: indexJsonFile.id,
  };
  const manifestFile = await drive.uploadText(
    SKILLS_FOLDER_ID,
    SKILL_SYNC_MANIFEST,
    JSON.stringify(manifest, null, 2) + '\n',
    'application/json; charset=utf-8',
  );

  runtime.skillSync = {
    updated_at: generatedAt,
    folder_id: SKILLS_FOLDER_ID,
    managed_count: Object.keys(nextManaged).length,
    indexed_count: indexedSkills.length,
    conflicts,
    removed,
    index_md_file_id: indexMdFile.id,
    index_json_file_id: indexJsonFile.id,
    manifest_file_id: manifestFile.id,
  };
  runtime.lastSkillSyncError = null;
  return runtime.skillSync;
}

async function syncMcpInventoryToDrive() {
  const epoch = clusterRuntime.lastTransitionAt;
  const inventoryActive = async () => canClaimCommands() && clusterRuntime.lastTransitionAt === epoch;
  if(!await inventoryActive())return null;
  if (!MCP_FOLDER_ID) {
    runtime.mcpSync = null;
    runtime.lastMcpSyncError = null;
    return null;
  }

  const syncedAt = new Date().toISOString();
  const [rawJson, rawMarkdown] = await Promise.all([
    fs.readFile(MCP_INVENTORY_JSON, 'utf8'),
    fs.readFile(MCP_INVENTORY_MD, 'utf8'),
  ]);
  const inventory = JSON.parse(rawJson);
  const servers = Array.isArray(inventory?.servers) ? inventory.servers : null;
  if (!servers) throw new Error('invalid MCP inventory: servers array missing');

  const sourceGeneratedAt = inventory.generated_at || null;
  const store = new UsageDriveStore(drive, MCP_FOLDER_ID, inventoryActive);
  const docs = await publishUsage({servers,store,home:HOME,journalPath:path.join(DATA,'mcp-usage-docs-journal.json'),now:syncedAt});
  const mdId='1Gqc32cEZtGTgQ2f4QvkcITdrlSGYUvP8',jsonId='1mvkob4mGkZc5R4HcQ4o0-uUyaT9GU2nP',manifestId='1l5KBRPNCejrpARvP2fwI1YCIqGAZzaCm';
  const currentMd=await store.read(mdId), currentJson=await store.read(jsonId);
  let oldJson;try{oldJson=JSON.parse(currentJson.text);}catch{throw Error('INVENTORY_JSON_INVALID');}
  for(const d of docs){if(d.status==='stale'){const previous=oldJson.usage_documents?.find(p=>p.name===d.name);if(previous?.tools)d.tools=previous.tools;}}
  const serverViews=servers.map(s=>Object.fromEntries(['name','version','source_commit','connection_mode','transport','health','last_verified_at','tool_count','tool_names'].filter(k=>s[k]!==undefined).map(k=>[k,s[k]])));
  const indexJson={...oldJson,schema:'chatgpt-drive-mcp-index-v2',generated_at:syncedAt,source_generated_at:sourceGeneratedAt,root_folder_id:MCP_FOLDER_ID,server_count:servers.length,servers:serverViews,usage_documents:docs};
  delete indexJson.content_hash;
  const rendered=renderIndex(servers,docs,sourceGeneratedAt);
  let mdBase=currentMd.text;
  if(!mdBase.includes('<!-- TMCP-USAGE:BEGIN ')){
    const oldHash=mdBase.match(/^<!-- inventory_content_hash: ([a-f0-9]{64}) -->/)?.[1];
    if(!oldHash||!remoteArtifactMatches('mcp','markdown',mdBase,oldHash))throw Error('INVENTORY_USER_EDIT_CONFLICT');
    mdBase='';
  }
  const artifacts=inventoryArtifacts('mcp',indexJson,rendered);
  await store.update(currentMd,mergeManaged(mdBase,rendered));
  await store.update(currentJson,artifacts.json);
  const currentManifest=await store.read(manifestId);
  let oldManifest;try{oldManifest=JSON.parse(currentManifest.text);}catch{throw Error('INVENTORY_MANIFEST_INVALID');}
  const manifest={...oldManifest,schema:'drive-worker-mcp-sync-manifest-v2',updated_at:syncedAt,source_generated_at:sourceGeneratedAt,server_count:servers.length,server_names:servers.map(s=>s.name),index_md_file_id:mdId,index_json_file_id:jsonId,usage_documents:docs.map(({tools,...d})=>d),publisher_version:VERSION};
  await store.update(currentManifest,JSON.stringify(manifest,null,2)+'\n');
  runtime.mcpSync={status:docs.every(d=>d.status!=='stale')?'VERIFIED':'PARTIAL_STALE',updated_at:syncedAt,folder_id:MCP_FOLDER_ID,server_count:servers.length,usage_doc_count:docs.filter(d=>d.id).length,index_md_file_id:mdId,index_json_file_id:jsonId,manifest_file_id:manifestId};
  runtime.lastMcpSyncError=docs.some(d=>d.status==='stale')?'USAGE_DOCS_STALE':null;
  return runtime.mcpSync;
}

function renderCapabilitiesMarkdown(capabilities) {
  const host = capabilities?.host || {};
  const notable = Object.entries(host.notable || {})
    .map(([name, location]) => '- ' + name + ': ' + (location || 'NOT FOUND'))
    .join('\n');
  const commands = (host.commands || []).join('\n');
  const skills = (capabilities?.skills?.installed || [])
    .map((item) => {
      const source = item.source ? ' — source: ' + item.source : '';
      const skillFile = item.locations?.[0]?.skill_file ? ' — ' + item.locations[0].skill_file : '';
      return '- ' + item.name + source + skillFile;
    })
    .join('\n') || '- none';
  const proot = (capabilities?.proot?.distributions || [])
    .map((item) => '- ' + item.name + ': ' + (item.command_count || 0) + ' commands')
    .join('\n') || '- none';
  return [
    '# Termux Capabilities',
    '',
    'Auto-generated shared inventory for RDC and Drive Worker. Do not edit manually.',
    '',
    '- detected_at: ' + String(capabilities?.detected_at || ''),
    '- home: ' + String(host.home || HOME),
    '- prefix: ' + String(host.prefix || PREFIX),
    '- executable_command_count: ' + String(host.command_count || 0),
    '- installed_skill_count: ' + String(capabilities?.skills?.installed_count || 0),
    '- exact command paths and skill metadata: TERMUX_CAPABILITIES.json',
    '',
    '## Notable programs',
    notable || '- none',
    '',
    '## 주요 프로그램 기능 및 대표 명령어',
    renderProgramInventoryMarkdown(capabilities?.programs),
    '',
    '## Installed agent skills',
    skills,
    '',
    '## All executable commands',
    '```text',
    commands,
    '```',
    '',
    '## proot distributions',
    proot,
    '',
  ].join('\n');
}

async function settleStartedWrites(writes) {
  // A rejection must not hide another write that is still running.
  const settled = await Promise.allSettled(writes);
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map((result) => result.value);
}

function refreshCapabilities() {
  if (shuttingDown) return Promise.resolve(null);
  return trackOperation(refreshCapabilitiesWork(), 'refreshCapabilities');
}

async function refreshCapabilitiesWork() {
  const epoch = clusterRuntime.lastTransitionAt;
  const inventoryActive = async () => canClaimCommands() && clusterRuntime.lastTransitionAt === epoch;
  if(!await inventoryActive())return null;
  try {
    const capabilities = await detectCapabilities({
      prefix: PREFIX,
      home: HOME,
      pathValue: process.env.PATH || '',
    });
    runtime.capabilities = capabilities;
    runtime.lastCapabilitiesAt = capabilities.detected_at;
    runtime.lastCapabilitiesError = null;
    const json = JSON.stringify(capabilities, null, 2) + '\n';
    const markdown = renderCapabilitiesMarkdown(capabilities);
    await settleStartedWrites([
      atomicWrite(CAPABILITIES_FILE, json),
      atomicWrite(TERMUX_CAPABILITIES_JSON, json),
      atomicWrite(TERMUX_CAPABILITIES_MD, markdown),
      atomicWrite(RDC_CAPABILITIES_JSON, json),
      atomicWrite(RDC_CAPABILITIES_MD, markdown),
    ]);
    const publication = await publishInventoryArtifacts({kind:'capabilities',artifacts:inventoryArtifacts('capabilities',capabilities,markdown),drive,isActive:inventoryActive,targets:[
      {id:'100FgF5vg8PRYfMQg2Au9S0EXAyrEEohw',format:'markdown',mimeType:'text/plain'},
      {id:'13MoHltvXNV6vJ5t1uuUfu-vQpBKMhvrY',format:'json',mimeType:'application/json'},
    ]});
    runtime.capabilitiesPublication = publication;
    if(publication.status!=='VERIFIED')throw Error('INVENTORY_CAPABILITIES_PUBLICATION_INCOMPLETE');
    try {
      await syncSkillsToDrive(capabilities);
    } catch (error) {
      runtime.lastSkillSyncError = String(error?.message || error).slice(0, 1000);
    }
    try {
      await syncMcpInventoryToDrive();
    } catch (error) {
      runtime.lastMcpSyncError = String(error?.message || error).slice(0, 1000);
    }
    return capabilities;
  } catch (error) {
    runtime.lastCapabilitiesError = String(error?.message || error).slice(0, 1000);
    return null;
  }
}

function capabilitySummary() {
  const caps = runtime.capabilities;
  return {
    updated_at: runtime.lastCapabilitiesAt,
    error: runtime.lastCapabilitiesError,
    publication: runtime.capabilitiesPublication || null,
    host_command_count: caps?.host?.command_count ?? 0,
    installed_skill_count: caps?.skills?.installed_count ?? 0,
    installed_skills: (caps?.skills?.installed || []).map((item) => ({
      name: item.name,
      source: item.source || null,
      source_url: item.source_url || null,
      skill_file: item.locations?.[0]?.skill_file || null,
    })),
    skill_drive_sync: runtime.skillSync ? { ...runtime.skillSync, error: runtime.lastSkillSyncError } : { error: runtime.lastSkillSyncError },
    mcp_drive_sync: runtime.mcpSync ? { ...runtime.mcpSync, error: runtime.lastMcpSyncError } : { error: runtime.lastMcpSyncError },
    proot_distributions: (caps?.proot?.distributions || []).map((item) => ({
      name: item.name,
      command_count: item.command_count || 0,
    })),
    shared_inventory: {
      markdown: TERMUX_CAPABILITIES_MD,
      json: TERMUX_CAPABILITIES_JSON,
      rdc_markdown: RDC_CAPABILITIES_MD,
      rdc_json: RDC_CAPABILITIES_JSON,
      drive_markdown: 'TERMUX_CAPABILITIES.md',
      drive_json: 'capabilities.json',
      mcp_markdown: MCP_INVENTORY_MD,
      mcp_json: MCP_INVENTORY_JSON,
    },
  };
}


async function refreshClusterRole() {
  const now = Date.now();
  const localName = serverName();
  const localPriority = serverPriority();
  const members = {};

  for (const file of await drive.listFolder(STATE_FOLDER_ID)) {
    if (!/^worker-[A-Za-z0-9._-]+\.json$/.test(String(file.name || ''))) continue;
    try {
      const body = JSON.parse((await drive.readText(file)).trim());
      const name = String(body.server_name || body.host || '').trim();
      if (!name) continue;
      const previous = members[name];
      if (!previous || stateTimestampMs(body) > stateTimestampMs(previous)) {
        members[name] = body;
      }
    } catch {}
  }

  members[localName] = {
    ...(members[localName] || {}),
    schema: 'drive-worker-state-v1',
    version: VERSION,
    server_name: localName,
    host: localName,
    server_priority: localPriority,
    role: clusterRuntime.role,
    updated_at: new Date(now).toISOString(),
    heartbeat_at: new Date(now).toISOString(),
    status: runtime.activeJobs.size ? 'BUSY' : 'IDLE',
  };

  const candidates = Object.values(members)
    .filter((state) => isMemberFresh(state, now))
    .map((state) => ({
      name: String(state.server_name || state.host || ''),
      priority: Number(state.server_priority || 100),
      state,
    }))
    .filter((entry) => entry.name)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  const winner = candidates[0] || { name: localName, priority: localPriority };
  const previousRole = clusterRuntime.role;
  const previousActive = clusterRuntime.activeServer;

  clusterRuntime.members = members;
  clusterRuntime.activeServer = winner.name;
  clusterRuntime.activePriority = winner.priority;
  clusterRuntime.lastElectionAt = new Date(now).toISOString();

  if (now < clusterRuntime.settleUntil) {
    clusterRuntime.role = 'CANDIDATE';
  } else {
    clusterRuntime.role = winner.name === localName ? 'ACTIVE' : 'STANDBY';
  }

  if (clusterRuntime.role === 'ACTIVE' && previousRole !== 'ACTIVE') {
    for (const fileId of standbyDeferredCommandFiles) seenCommandFiles.delete(fileId);
    standbyDeferredCommandFiles.clear();
    clusterRuntime.claimReadyAt = previousRole === 'CANDIDATE'
      ? Math.max(now, clusterRuntime.settleUntil)
      : now + CLUSTER_SETTLE_MS;
  }

  if (clusterRuntime.role !== previousRole || clusterRuntime.activeServer !== previousActive) {
    clusterRuntime.lastTransitionAt = new Date(now).toISOString();
    console.log(JSON.stringify({
      event: 'DRIVE_WORKER_CLUSTER_ROLE',
      host: localName,
      role: clusterRuntime.role,
      active_server: clusterRuntime.activeServer,
      active_priority: clusterRuntime.activePriority,
    }));
  }

  return clusterRuntime.role;
}

function clusterStateBody() {
  return {
    schema: 'drive-worker-cluster-state-v1',
    version: VERSION,
    updated_at: new Date().toISOString(),
    active_server: clusterRuntime.activeServer,
    active_priority: clusterRuntime.activePriority,
    member_timeout_ms: CLUSTER_MEMBER_TIMEOUT_MS,
    settle_ms: CLUSTER_SETTLE_MS,
    claim_ready_at: new Date(clusterRuntime.claimReadyAt || 0).toISOString(),
    claim_ready: canClaimCommands(),
  };
}

function heartbeat(extra = {}) {
  return trackOperation(heartbeatWork(extra), 'heartbeat');
}

async function heartbeatWork(extra = {}) {
  const body = {
    schema: 'drive-worker-state-v1',
    version: VERSION,
    status: runtime.activeJobs.size ? 'BUSY' : 'IDLE',
    started_at: runtime.startedAt,
    updated_at: new Date().toISOString(),
    host: serverName(),
    server_name: serverName(),
    server_priority: serverPriority(),
    role: clusterRuntime.role,
    active_server: clusterRuntime.activeServer,
    active_priority: clusterRuntime.activePriority,
    heartbeat_at: new Date().toISOString(),
    cluster_member_timeout_ms: CLUSTER_MEMBER_TIMEOUT_MS,
    claim_ready_at: new Date(clusterRuntime.claimReadyAt || 0).toISOString(),
    claim_ready: canClaimCommands(),
    pid: process.pid,
    poll_ms: POLL_MS,
    max_concurrency: concurrencySnapshot().effective,
    concurrency: concurrencySnapshot(),
    active_job: firstActiveJob(),
    active_jobs: activeJobsSnapshot(),
    last_poll_at: runtime.lastPollAt,
    last_success_at: runtime.lastSuccessAt,
    last_error: runtime.lastError,
    processed_jobs: runtime.processed,
    cleanup: cleanupSummary(),
    capabilities: capabilitySummary(),
    profile_sync: profileSyncSummary(),
    drain: drainSummary(),
    commands_folder_id: COMMANDS_FOLDER_ID,
    results_folder_id: RESULTS_FOLDER_ID,
    ...extra,
  };
  await drive.upsertJson(STATE_FOLDER_ID, memberStateFileName(), body);
  if (clusterRuntime.role === 'ACTIVE') {
    await drive.upsertJson(STATE_FOLDER_ID, 'worker-state.json', body);
    await drive.upsertJson(STATE_FOLDER_ID, 'cluster-state.json', clusterStateBody());
  }
}

function commandSummary(job, file) {
  return {
    schema: 'drive-worker-result-v1',
    job_id: String(job.job_id || ''),
    command_file_id: file.id,
    command_file_name: sanitizeOutboundText(file.name),
    command: sanitizeOutboundText(String(job.command || '')),
    target_server: commandTargetServer(job) || null,
    cwd: String(job.cwd || HOME),
    shell: String(job.shell || DEFAULT_SHELL),
  };
}


async function enforceCommandResumeFence(file, job) {
  const fence = await loadResumeFence(
    path.join(HOME, '.termux-watchdog', 'command-resume-fence-v1.json'),
    path.join(HOME, '.termux-watchdog', 'power-mode-v2.json'),
    serverName(),
  );
  if (fence.kind === 'NONE') return { allowed: true, reason: 'no_resume_fence' };
  if (fence.kind !== 'READY') {
    return { allowed: false, retry_later: true, reason: fence.reason };
  }
  let commandMetadata;
  let originMetadata = null;
  try {
    commandMetadata = await drive.getMetadata(file.id);
    if (job.origin_command_file_id) {
      const sourceId = String(job.origin_command_file_id);
      if (sourceId === file.id) return { allowed: false, retry_later: true, reason: 'routed_origin_invalid' };
      originMetadata = await drive.getMetadata(sourceId);
    } else if (/\\.target-[A-Za-z0-9._-]+\\.json$/.test(file.name)) {
      return { allowed: false, retry_later: true, reason: 'routed_origin_missing' };
    }
  } catch {
    return { allowed: false, retry_later: true, reason: 'provider_metadata_read_failed' };
  }
  const verdict = classifyCommandAdmission(fence, commandMetadata, originMetadata, {
    commandsFolderId: COMMANDS_FOLDER_ID,
  });
  if (!verdict.allowed && !verdict.retry_later) {
    const record = {
      event: 'DRIVE_WORKER_COMMAND_EXCLUDED_BY_RESUME',
      server_name: serverName(), job_id: safeJobName(job.job_id),
      command_file_id: file.id, origin_command_file_id: job.origin_command_file_id || file.id,
      reason: verdict.reason, received_at: verdict.received_at, cutoff_at: verdict.cutoff_at,
      admission_basis: verdict.admission_basis, recorded_at: new Date().toISOString(),
    };
    try {
      await fs.appendFile(path.join(DATA, 'resume-command-exclusions.jsonl'), JSON.stringify(record) + '\\n', { mode: 0o600 });
      console.log(JSON.stringify(record));
    } catch {
      return { allowed: false, retry_later: true, reason: 'exclusion_audit_failed' };
    }
  }
  return verdict;
}

// The local terminal record is authoritative for whether a command ran.
// A failed Drive publication may be retried, but the command must never run again.
const publicationRetryAfter = new Map();
async function readExecutionJournal(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
async function writeExecutionJournal(file, value) {
  const temp = file + '.tmp-' + process.pid;
  const handle = await fs.open(temp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await fs.rename(temp, file);
}
async function publishRecordedResult(jobId, resultFile, resultName, recorded) {
  const jobDir = path.join(DATA, 'jobs', jobId);
  const stdoutText = sanitizeOutboundText(await fs.readFile(path.join(jobDir, 'stdout.log'), 'utf8'));
  const stderrText = sanitizeOutboundText(await fs.readFile(path.join(jobDir, 'stderr.log'), 'utf8'));
  const stdoutFile = await drive.uploadText(RESULTS_FOLDER_ID, jobId + '.stdout.txt', stdoutText);
  const stderrFile = await drive.uploadText(RESULTS_FOLDER_ID, jobId + '.stderr.txt', stderrText);
  const result = {
    ...recorded,
    stdout_tail: stdoutText.slice(-32768), stderr_tail: stderrText.slice(-32768),
    stdout_file_id: stdoutFile.id, stderr_file_id: stderrFile.id,
  };
  if (resultFile) {
    await drive.updateBytes(resultFile.id, 'application/json; charset=utf-8', JSON.stringify(result, null, 2) + '\n');
  } else {
    await drive.createBytes(RESULTS_FOLDER_ID, resultName, 'application/json; charset=utf-8', JSON.stringify(result, null, 2) + '\n');
  }
  publicationFailures.delete(jobId);
  publicationRetryAfter.delete(jobId);
  unsettledResults.delete(jobId);
  return result;
}

const claimingJobIds = new Set();
async function runJob(file, job) {
  const id = safeJobName(job?.job_id);
  if (id && claimingJobIds.has(id)) {
    return { skipped: true, reason: 'job_claim_in_flight', retry_later: true };
  }
  if (id) claimingJobIds.add(id);
  try { return await runJobExclusive(file, job); }
  finally { if (id) claimingJobIds.delete(id); }
}

async function runJobExclusive(file, job) {
  if (shuttingDown) return { skipped: true, reason: 'draining', retry_later: true };
  const jobId = safeJobName(job.job_id);
  if (!jobId) throw new Error('job_id required');
  if (typeof job.command !== 'string' || !job.command.trim()) {
    throw new Error('command required');
  }

  const targetServer = commandTargetServer(job);
  const autoTarget = targetServer.toUpperCase() === 'AUTO';
  if (targetServer && !autoTarget && targetServer !== serverName()) {
    return { skipped: true, reason: 'target_server_mismatch', target_server: targetServer };
  }
  if ((autoTarget || !targetServer) && clusterRuntime.role === 'STANDBY') {
    return { skipped: true, reason: autoTarget ? 'standby_auto_wait' : 'standby_untargeted', defer_until_active: true };
  }
  if ((autoTarget || !targetServer) && !canClaimCommands()) {
    return { skipped: true, reason: 'claim_not_ready', retry_later: true };
  }

  // Duplicate names and stale claims are never permission to execute twice.
  if (runtime.activeJobs.has(jobId) || unsettledResults.has(jobId)) {
    return { skipped: true, reason: 'job_already_in_flight', retry_later: true };
  }
  if (Date.now() < (publicationRetryAfter.get(jobId) || 0)) {
    return { skipped: true, reason: 'publication_backoff', retry_later: true };
  }
  const jobDir = path.join(DATA, 'jobs', jobId);
  const acceptedPath = path.join(jobDir, 'execution-accepted.json');
  const terminalPath = path.join(jobDir, 'terminal-result.json');
  const resultName = jobId + '.json';
  const existing = await drive.findByName(RESULTS_FOLDER_ID, resultName);
  let previousResult = null;
  if (existing) {
    try { previousResult = JSON.parse((await drive.readText(existing)).trim()); }
    catch (error) {
      publicationFailures.set(jobId, 'existing Result unreadable: ' + String(error?.message || error).slice(0, 300));
      return { skipped: true, reason: 'existing_result_unreadable' };
    }
    if (TERMINAL_RESULT_STATUSES.has(String(previousResult?.status || '').toUpperCase())) {
      return { skipped: true, reason: 'result_exists' };
    }
  }
  const previousJournal = await readExecutionJournal(terminalPath);
  const accepted = await readExecutionJournal(acceptedPath);
  if (existing || previousJournal || accepted) {
    if (previousJournal?.job_id === jobId && previousJournal?.command_file_id === file.id
        && TERMINAL_RESULT_STATUSES.has(String(previousJournal.status || '').toUpperCase())) {
      try {
        const result = await publishRecordedResult(jobId, existing, resultName, previousJournal);
        return { skipped: true, reason: 'terminal_result_republished', result };
      } catch (error) {
        publicationFailures.set(jobId, String(error?.message || error).slice(0, 400));
        publicationRetryAfter.set(jobId, Date.now() + 60000);
        return { skipped: true, reason: 'terminal_publication_pending', retry_later: true };
      }
    }
    const previousHost = String(previousResult?.executor_host || '').trim();
    if (previousHost && previousHost !== serverName() && memberIsAlive(previousHost)) {
      return { skipped: true, reason: 'result_in_progress_on_live_peer', retry_later: true };
    }
    // If a Worker vanished mid-command, the external effect is unknown.
    // Quarantine instead of automatically replaying an unsafe command.
    const errorResult = {
      ...(previousResult || commandSummary(job, file)),
      status: 'ERROR', completed_at: new Date().toISOString(),
      recovered_after_restart: true, execution_outcome_uncertain: true,
      error: 'previous execution is unresolved; command not replayed',
    };
    try {
      if (existing) await drive.updateBytes(existing.id, 'application/json; charset=utf-8', JSON.stringify(errorResult, null, 2) + '\n');
      else await drive.createBytes(RESULTS_FOLDER_ID, resultName, 'application/json; charset=utf-8', JSON.stringify(errorResult, null, 2) + '\n');
      publicationFailures.delete(jobId);
      return { skipped: true, reason: 'prior_execution_quarantined' };
    } catch (error) {
      publicationFailures.set(jobId, String(error?.message || error).slice(0, 400));
      publicationRetryAfter.set(jobId, Date.now() + 60000);
      return { skipped: true, reason: 'quarantine_publication_pending', retry_later: true };
    }
  }

  const admission = await enforceCommandResumeFence(file, job);
  if (!admission.allowed) return { skipped: true, ...admission };

  // A claim request already sent before the fence is accepted work, even
  // when its response arrives after a signal. Keep its terminal result tracked.
  if (shuttingDown) return { skipped: true, reason: 'draining', retry_later: true };
  unsettledResults.set(jobId, { command_file_id: file.id });
  const claimed = {
    ...commandSummary(job, file),
    status: 'CLAIMED',
    claimed_at: new Date().toISOString(),
    executor_host: serverName(),
    executor_priority: serverPriority(),
    execution_attempt: Number(previousResult?.execution_attempt || 0) + 1,
    takeover_from_host: previousResult?.executor_host || null,
  };
  let resultFile = existing;
  try {
    if (resultFile) {
      await drive.updateBytes(resultFile.id, 'application/json; charset=utf-8', JSON.stringify(claimed, null, 2) + '\n');
    } else {
      resultFile = await drive.createBytes(RESULTS_FOLDER_ID, resultName, 'application/json; charset=utf-8', JSON.stringify(claimed, null, 2) + '\n');
    }
  } catch (error) {
    unsettledResults.delete(jobId);
    throw error;
  }

  await fs.mkdir(jobDir, { recursive: true });
  // This marker is persisted before spawn. An ambiguous crash must not run twice.
  await writeExecutionJournal(acceptedPath, { job_id: jobId, command_file_id: file.id, executor_host: serverName(), claimed_at: claimed.claimed_at });
  const stdoutPath = path.join(jobDir, 'stdout.log');
  const stderrPath = path.join(jobDir, 'stderr.log');
  await fs.writeFile(stdoutPath, '');
  await fs.writeFile(stderrPath, '');

  const shell = String(job.shell || DEFAULT_SHELL);
  const cwd = String(job.cwd || HOME);
  const timeoutMs = Math.max(0, Number(job.timeout_ms || 0));
  const env = { ...process.env };
  if (job.env && typeof job.env === 'object' && !Array.isArray(job.env)) {
    for (const [key, value] of Object.entries(job.env)) {
      env[String(key)] = String(value);
    }
  }

  const stdout = fss.createWriteStream(stdoutPath, { flags: 'a' });
  const stderr = fss.createWriteStream(stderrPath, { flags: 'a' });
  const child = spawn(shell, ['-lc', job.command], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let spawnError = null;
  const outcomePromise = new Promise((resolve) => {
    let settled = false;
    let exitFallback = null;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (exitFallback) clearTimeout(exitFallback);
      resolve({ code, signal, spawnError });
    };
    child.once('error', (error) => { spawnError = error; finish(null, null); });
    child.once('close', finish);
    child.once('exit', (code, signal) => {
      // A descendant holding stdio open must not retain an exited child forever.
      exitFallback = setTimeout(() => {
        terminateChildTree(child, 'SIGTERM');
        child.stdout?.destroy(); child.stderr?.destroy();
        finish(code, signal);
      }, 3000);
      exitFallback.unref?.();
    });
  });
  const activeJob = {
    job_id: jobId,
    pid: child.pid,
    command_file_id: file.id,
    started_at: new Date().toISOString(),
  };
  runtime.currentChildren.set(jobId, child);
  runtime.activeJobs.set(jobId, activeJob);
  let timedOut = false;
  let timer = null;
  let outcome;
  try {
    child.stdout.pipe(stdout, { end: false });
    child.stderr.pipe(stderr, { end: false });
    child.stdin.on('error', () => {});
    if (job.stdin != null) child.stdin.end(String(job.stdin));
    else child.stdin.end();
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateChildTree(child, 'SIGTERM');
        setTimeout(() => {
          if (child.exitCode == null) terminateChildTree(child, 'SIGKILL');
        }, 3000).unref();
      }, timeoutMs);
      timer.unref();
    }
    try {
      await drive.updateBytes(resultFile.id, 'application/json; charset=utf-8', JSON.stringify({
        ...claimed, status: 'RUNNING', pid: child.pid,
        started_at: activeJob.started_at, timeout_ms: timeoutMs,
      }, null, 2) + '\n');
    } catch (error) {
      publicationFailures.set(jobId, String(error?.message || error).slice(0, 400));
    }
    outcome = await outcomePromise;
  } finally {
    if (timer) clearTimeout(timer);
    if (!outcome) {
      terminateChildTree(child, 'SIGTERM');
      await Promise.race([outcomePromise, delay(4000)]);
      if (child.exitCode == null) terminateChildTree(child, 'SIGKILL');
    }
    runtime.activeJobs.delete(jobId);
    runtime.currentChildren.delete(jobId);
  }

  await Promise.all([
    new Promise((resolve) => stdout.end(resolve)),
    new Promise((resolve) => stderr.end(resolve)),
  ]);

  const stdoutText = sanitizeOutboundText(await fs.readFile(stdoutPath, 'utf8'));
  const stderrText = sanitizeOutboundText(await fs.readFile(stderrPath, 'utf8'));
  const finishedAt = new Date().toISOString();
  const status = timedOut ? 'TIMED_OUT'
    : outcome.spawnError ? 'ERROR' : outcome.code === 0 ? 'DONE' : 'FAILED';
  const recorded = {
    ...claimed, status, pid: child.pid, exit_code: outcome.code,
    signal: outcome.signal, timed_out: timedOut,
    error: sanitizeOutboundText(outcome.spawnError ? String(outcome.spawnError.message || outcome.spawnError) : ''),
    started_at: activeJob.started_at, completed_at: finishedAt,
    stdout_tail: stdoutText.slice(-32768), stderr_tail: stderrText.slice(-32768),
  };
  await writeExecutionJournal(terminalPath, recorded);
  unsettledResults.delete(jobId);
  runtime.lastSuccessAt = finishedAt;
  runtime.processed += 1;
  try {
    const result = await publishRecordedResult(jobId, resultFile, resultName, recorded);
    runtime.lastError = null;
    void heartbeat().catch(() => {});
    return { skipped: false, result };
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 400);
    publicationFailures.set(jobId, reason);
    publicationRetryAfter.set(jobId, Date.now() + 60000);
    runtime.lastError = reason;
    void heartbeat().catch(() => {});
    return { skipped: false, reason: 'terminal_publication_pending', retry_later: true };
  }
}

const seenCommandFiles = new Set();
const standbyDeferredCommandFiles = new Set();
const inFlightCommandFiles = new Set();

function cleanupSummary() {
  return {
    enabled: false,
    interval_ms: null,
    done_detail_retention_ms: CLEANUP_DONE_DETAIL_RETENTION_MS,
    failure_retention_ms: CLEANUP_FAILURE_RETENTION_MS,
    orphan_retention_ms: CLEANUP_ORPHAN_RETENTION_MS,
    result_json_policy: 'preserve_immutable',
    result_json_mutation_allowed: false,
    last_run_at: runtime.cleanup.last_run_at,
    last_success_at: runtime.cleanup.last_success_at,
    last_error: runtime.cleanup.last_error,
    last_stats: runtime.cleanup.last_stats,
    total_runs: runtime.cleanup.total_runs,
    total_drive_trashed: runtime.cleanup.total_drive_trashed,
    total_local_jobs_removed: runtime.cleanup.total_local_jobs_removed,
  };
}

async function cleanupTrashFile(fileId, stats) {
  if (!fileId) return false;
  try {
    await drive.trashFile(String(fileId));
    stats.drive_trashed += 1;
    return true;
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('Drive trash failed: 404')) {
      stats.drive_missing += 1;
      return false;
    }
    throw error;
  }
}

async function cleanupLiveFile(fileId, liveIds, stats) {
  const id = String(fileId || '').trim();
  if (!id || !liveIds.has(id)) return false;
  const changed = await cleanupTrashFile(id, stats);
  if (changed) liveIds.delete(id);
  return changed;
}

async function cleanupLocalJob(jobId, stats) {
  const safe = safeJobName(jobId);
  if (!safe || runtime.activeJobs.has(safe)) return false;
  const target = path.join(DATA, 'jobs', safe);
  try {
    await fs.stat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  await fs.rm(target, { recursive: true, force: true });
  stats.local_jobs_removed += 1;
  return true;
}

async function cleanupArtifacts() {
  const runAt = new Date().toISOString();
  const now = Date.now();
  const stats = {
    run_at: runAt,
    drive_trashed: 0,
    drive_missing: 0,
    done_details_cleaned: 0,
    failure_details_cleaned: 0,
    orphan_commands_trashed: 0,
    local_jobs_removed: 0,
    protected_nonterminal_results: 0,
    skipped_unreadable_results: 0,
    skipped_unaged_items: 0,
    result_json_modified: 0,
    result_json_trashed: 0,
  };
  runtime.cleanup.last_run_at = runAt;
  runtime.cleanup.last_error = null;

  try {
    const activeCommandIds = new Set(
      activeJobsSnapshot().map((item) => String(item.command_file_id || '')).filter(Boolean),
    );
    const activeJobIds = new Set(activeJobsSnapshot().map((item) => String(item.job_id || '')).filter(Boolean));
    const referencedCommandIds = new Set();
    const remainingResultJobIds = new Set();

    const resultFiles = await drive.listFolder(RESULTS_FOLDER_ID);
    const liveResultFileIds = new Set(resultFiles.map((file) => String(file.id || '')).filter(Boolean));
    const commandFiles = await drive.listFolder(COMMANDS_FOLDER_ID);
    const liveCommandFileIds = new Set(commandFiles.map((file) => String(file.id || '')).filter(Boolean));

    for (const file of resultFiles) {
      if (file.mimeType === 'application/vnd.google-apps.folder') continue;
      if (!String(file.name || '').endsWith('.json')) continue;

      let body;
      try {
        body = JSON.parse(await drive.readText(file));
      } catch {
        stats.skipped_unreadable_results += 1;
        continue;
      }

      const commandFileId = String(body?.command_file_id || '');
      if (commandFileId) {
        referencedCommandIds.add(commandFileId);
        seenCommandFiles.add(commandFileId);
      }

      const status = String(body?.status || '').toUpperCase();
      const fileJobId = String(file.name || '').endsWith('.json')
        ? String(file.name).slice(0, -5)
        : '';
      const jobId = safeJobName(body?.job_id || (fileJobId.startsWith('invalid-') ? '' : fileJobId));
      if (jobId) remainingResultJobIds.add(jobId);

      if (jobId && activeJobIds.has(jobId)) {
        stats.protected_nonterminal_results += 1;
        continue;
      }
      if (commandFileId && (activeCommandIds.has(commandFileId) || inFlightCommandFiles.has(commandFileId))) {
        stats.protected_nonterminal_results += 1;
        continue;
      }
      if (!TERMINAL_RESULT_STATUSES.has(status)) {
        stats.protected_nonterminal_results += 1;
        continue;
      }

      const age = elapsedMs(body?.completed_at || file.modifiedTime, now);
      if (age == null) {
        stats.skipped_unaged_items += 1;
        continue;
      }

      const detailRetentionMs = status === 'DONE'
        ? CLEANUP_DONE_DETAIL_RETENTION_MS
        : CLEANUP_FAILURE_RETENTION_MS;
      if (age < detailRetentionMs) continue;

      let changed = false;
      changed = (await cleanupLiveFile(commandFileId, liveCommandFileIds, stats)) || changed;
      changed = (await cleanupLiveFile(body?.stdout_file_id, liveResultFileIds, stats)) || changed;
      changed = (await cleanupLiveFile(body?.stderr_file_id, liveResultFileIds, stats)) || changed;
      changed = (await cleanupLocalJob(jobId, stats)) || changed;
      if (changed) {
        if (status === 'DONE') stats.done_details_cleaned += 1;
        else stats.failure_details_cleaned += 1;
      }
    }

    for (const file of commandFiles) {
      if (activeCommandIds.has(file.id) || inFlightCommandFiles.has(file.id)) continue;
      if (referencedCommandIds.has(file.id)) continue;
      const age = elapsedMs(file.modifiedTime, now);
      if (age == null) {
        stats.skipped_unaged_items += 1;
        continue;
      }
      if (age >= CLEANUP_ORPHAN_RETENTION_MS) {
        if (await cleanupLiveFile(file.id, liveCommandFileIds, stats)) {
          seenCommandFiles.delete(file.id);
          stats.orphan_commands_trashed += 1;
        }
      }
    }

    const jobsDir = path.join(DATA, 'jobs');
    const localEntries = await fs.readdir(jobsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of localEntries) {
      if (!entry.isDirectory()) continue;
      const jobId = safeJobName(entry.name);
      if (!jobId || activeJobIds.has(jobId) || remainingResultJobIds.has(jobId)) continue;
      const target = path.join(jobsDir, entry.name);
      let stat;
      try {
        stat = await fs.stat(target);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs >= CLEANUP_ORPHAN_RETENTION_MS) {
        await fs.rm(target, { recursive: true, force: true });
        stats.local_jobs_removed += 1;
      }
    }

    runtime.cleanup.last_success_at = new Date().toISOString();
    runtime.cleanup.last_stats = stats;
    runtime.cleanup.total_runs += 1;
    runtime.cleanup.total_drive_trashed += stats.drive_trashed;
    runtime.cleanup.total_local_jobs_removed += stats.local_jobs_removed;
    return stats;
  } catch (error) {
    runtime.cleanup.last_error = String(error?.message || error).slice(0, 1000);
    runtime.cleanup.last_stats = stats;
    throw error;
  }
}

async function recordInvalid(file, error, raw = '') {
  const name = 'invalid-' + safeJobName(file.id) + '.json';
  const body = {
    schema: 'drive-worker-result-v1',
    status: 'INVALID',
    command_file_id: file.id,
    command_file_name: sanitizeOutboundText(file.name),
    error: sanitizeOutboundText(String(error?.message || error)),
    raw_tail: sanitizeOutboundText(String(raw || '').slice(-32768)),
    completed_at: new Date().toISOString(),
  };
  await drive.upsertJson(RESULTS_FOLDER_ID, name, body);
}

function processCommandFile(file) {
  if (shuttingDown) return Promise.resolve({ skipped: true, reason: 'draining', retry_later: true });
  return trackOperation(processCommandFileWork(file), 'processCommandFile');
}

async function processCommandFileWork(file) {
  let raw = '';
  try {
    raw = await drive.readText(file);
    const job = JSON.parse(raw.trim());
    if (job.schema && job.schema !== 'drive-worker-command-v1') {
      throw new Error('unsupported command schema');
    }
    const result = await runJob(file, job);
    if (result?.defer_until_active) {
      seenCommandFiles.add(file.id);
      standbyDeferredCommandFiles.add(file.id);
    } else if (!result?.retry_later) {
      seenCommandFiles.add(file.id);
    }
    return result;
  } catch (error) {
    let jobId = '';
    try { jobId = safeJobName(JSON.parse(raw).job_id); } catch {}
    if (jobId && unsettledResults.has(jobId)) {
      // A claim may have reached Drive: preserve the record, not INVALID.
      publicationFailures.set(jobId, String(error?.message || error).slice(0, 400));
      if (!runtime.activeJobs.has(jobId)) unsettledResults.delete(jobId);
    } else {
      await recordInvalid(file, error, raw).catch((publicationError) => {
        publicationFailures.set(file.id, String(publicationError?.message || publicationError).slice(0, 1000));
      });
    }
    seenCommandFiles.add(file.id);
    throw error;
  }
}

let shuttingDown = false;
let heartbeatTimer = null;
let cpuSamplerTimer = null;
let nextCapabilitiesAt = 0;
let shutdownTask = null;
let lifecycleTask = null;
let drainStartedAt = null;
let drainCompletedAt = null;
let drainBlockedReason = null;
const pendingOperations = new Map();
const unsettledResults = new Map();
const publicationFailures = new Map();

function trackOperation(promise, kind) {
  pendingOperations.set(promise, kind);
  promise.then(() => pendingOperations.delete(promise), () => pendingOperations.delete(promise));
  return promise;
}

function drainSummary() {
  return {
    requested: shuttingDown,
    started_at: drainStartedAt,
    completed_at: drainCompletedAt,
    status: !shuttingDown ? 'ACTIVE' : drainCompletedAt ? 'COMPLETE'
      : drainBlockedReason ? 'BLOCKED' : 'WAITING',
    blocked_reason: drainBlockedReason,
    pending_operations: [...pendingOperations.values()],
    in_flight_commands: inFlightCommandFiles.size,
    active_children: runtime.currentChildren.size,
    unsettled_job_ids: [...unsettledResults.keys()],
    publication_failure_ids: [...publicationFailures.keys()],
  };
}

async function waitForOperations(includeHeartbeat = false) {
  for (;;) {
    const pending = [...pendingOperations].filter(([, kind]) => includeHeartbeat || kind !== 'heartbeat');
    if (!pending.length) return;
    await Promise.allSettled(pending.map(([promise]) => promise));
  }
}

function holdDrain(reason) {
  drainBlockedReason = reason;
  runtime.lastError = reason;
  console.error(JSON.stringify({ event: 'DRIVE_WORKER_DRAIN_BLOCKED', reason, drain: drainSummary() }));
  // No deadline or child signal: an operator must resolve the publication error.
  // The open health server and heartbeat keep the existing executor visible.
  startHeartbeatTimer();
  return new Promise(() => {});
}

function startHeartbeatTimer() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error) => {
      runtime.lastError = String(error?.message || error).slice(0, 1000);
    });
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

function startCpuSampler() {
  if (process.platform !== 'android' || cpuSamplerTimer) return;
  cpuSamplerTimer = setInterval(() => {
    void refreshCpuUsageSample();
  }, CPU_SAMPLE_MS);
  cpuSamplerTimer.unref?.();
}

function routeOneQueuedCommandToStandby(files) {
  if (shuttingDown) return Promise.resolve(null);
  const publication = { started: false };
  const operation = routeOneQueuedCommandToStandbyWork(files, publication).catch((error) => {
    if (publication.started) {
      publicationFailures.set('routing', String(error?.message || error).slice(0, 1000));
    }
    throw error;
  });
  return trackOperation(operation, 'routeOneQueuedCommandToStandby');
}

async function routeOneQueuedCommandToStandbyWork(files, publication) {
  if (!canClaimCommands()) return null;
  const standby = standbyOverflowCandidate();
  if (!standby) return null;

  for (const file of files) {
    if (seenCommandFiles.has(file.id) || inFlightCommandFiles.has(file.id)) continue;

    let raw = '';
    let job;
    try {
      raw = await drive.readText(file);
      job = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    if (job.schema && job.schema !== 'drive-worker-command-v1') continue;
    const requestedTarget = commandTargetServer(job);
    if (requestedTarget && requestedTarget.toUpperCase() !== 'AUTO') continue;
    const jobId = safeJobName(job.job_id);
    if (!jobId || typeof job.command !== 'string' || !job.command.trim()) continue;

    const resultName = jobId + '.json';
    const existing = await drive.findByName(RESULTS_FOLDER_ID, resultName);
    if (existing) {
      let body = null;
      try { body = JSON.parse((await drive.readText(existing)).trim()); } catch {}
      const status = String(body?.status || '').toUpperCase();
      if (TERMINAL_RESULT_STATUSES.has(status)) {
        seenCommandFiles.add(file.id);
        continue;
      }
      const host = String(body?.executor_host || '').trim();
      if (host && memberIsAlive(host)) {
        seenCommandFiles.add(file.id);
        continue;
      }
      continue;
    }

    // Preserve original provenance. A newly created routed file is not a new
    // command receipt and cannot bypass the standby server's resume cutoff.
    const originId = String(job.origin_command_file_id || file.id);
    let originMetadata;
    try { originMetadata = await drive.getMetadata(originId); } catch { continue; }
    if (!originMetadata?.createdTime || originMetadata?.trashed) continue;
    const routedJob = { ...job, target_server: standby.name,
      origin_command_file_id: originId, origin_command_created_at: originMetadata.createdTime };
    const routedName = jobId + '.target-' + safeServerKey(standby.name) + '.json';
    let routedFile = await drive.findByName(COMMANDS_FOLDER_ID, routedName);
    if (shuttingDown) return null;
    if (!routedFile) {
      publication.started = true;
      routedFile = await drive.createBytes(
        COMMANDS_FOLDER_ID,
        routedName,
        'application/json; charset=utf-8',
        JSON.stringify(routedJob, null, 2) + '\n',
      );
    }

    const routeClaim = {
      ...commandSummary(routedJob, routedFile),
      status: 'CLAIMED',
      claimed_at: new Date().toISOString(),
      executor_host: standby.name,
      executor_priority: standby.priority,
      routed_by: serverName(),
      routed_at: new Date().toISOString(),
    };
    const lock = await drive.findByName(RESULTS_FOLDER_ID, resultName);
    if (shuttingDown) return null;
    if (!lock) {
      publication.started = true;
      await drive.createBytes(
        RESULTS_FOLDER_ID,
        resultName,
        'application/json; charset=utf-8',
        JSON.stringify(routeClaim, null, 2) + '\n',
      );
    }

    seenCommandFiles.add(file.id);
    console.log(JSON.stringify({
      event: 'DRIVE_WORKER_COMMAND_ROUTED',
      job_id: jobId,
      from_server: serverName(),
      target_server: standby.name,
      source_command_file_id: file.id,
      routed_command_file_id: routedFile.id,
    }));
    return { job_id: jobId, target_server: standby.name, routed_command_file_id: routedFile.id };
  }
  return null;
}

async function pollOnce() {
  if (shuttingDown) return;
  runtime.lastPollAt = new Date().toISOString();
  const files = (await drive.listFolder(COMMANDS_FOLDER_ID)).sort(
    (a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')),
  );
  const concurrency = concurrencySnapshot();
  for (const file of files) {
    if (shuttingDown) return;
    if (seenCommandFiles.has(file.id) || inFlightCommandFiles.has(file.id)) continue;
    if (inFlightCommandFiles.size >= concurrency.effective) {
      if (canClaimCommands()) await routeOneQueuedCommandToStandby([file]);
      break;
    }

    inFlightCommandFiles.add(file.id);
    const operation = processCommandFile(file)
      .catch((error) => {
        runtime.lastError = String(error?.message || error).slice(0, 1000);
      })
      .finally(() => {
        inFlightCommandFiles.delete(file.id);
      });
    void trackOperation(operation, 'command-dispatch');
  }
}

function profileSyncConfig() {
  return {
    schema: 'selfrun-profile-sync-runtime-v1',
    enabled: true,
    dry_run: false,
    registries: {
      CHAT: { document_id: process.env.DRIVE_WORKER_CHAT_PROFILE_REGISTRY_ID || '1CblWAg3XWuVYbGIuUt0TLKGuIyhRX3yW2KCmvAmZ75Q' },
      WORK: { document_id: process.env.DRIVE_WORKER_WORK_PROFILE_REGISTRY_ID || '1TB5_H84_2ypC5XFAdEaopySyBpkKBHLOcPB5s3naDOo' },
    },
    sources: {
      work_verified_snapshot_file: path.join(DATA, 'profile-sync', 'verified-work-profiles.json'),
    },
  };
}

function profileSyncSummary() {
  return {
    coordination: runtime.profileSyncCoordination || {status:'IDLE'},
    refresh_ms: PROFILE_SYNC_REFRESH_MS,
    running: runtime.profileSyncRunning,
    next_at: new Date(Number(runtime.nextProfileSyncAt || 0)).toISOString(),
    error: runtime.lastProfileSyncError,
    state: runtime.profileSync,
  };
}

function refreshProfileRegistries() {
  if (shuttingDown) return Promise.resolve(null);
  return trackOperation(refreshProfileRegistriesWork(), 'refreshProfileRegistries');
}

function createProfileSyncCoordinator(){return new ProfileSyncCoordinator({drive,documentId:process.env.DRIVE_WORKER_PROFILE_SYNC_COORDINATION_DOCUMENT_ID,journalPath:path.join(DATA,'profile-sync','coordination-journal.json'),host:serverName()});}
let nextProfileSyncRecoveryAt=0;
function maintainProfileSyncRecovery(){
  if(shuttingDown||runtime.profileSyncRunning||runtime.profileSyncRecoveryRunning||Date.now()<nextProfileSyncRecoveryAt||!fss.existsSync(path.join(DATA,'profile-sync','coordination-journal.json')))return Promise.resolve();
  nextProfileSyncRecoveryAt=Date.now()+15000;runtime.profileSyncRecoveryRunning=true;
  return trackOperation((async()=>{try{const coordinator=createProfileSyncCoordinator();if(!coordinator.owner)return;runtime.profileSyncCoordination=await coordinator.recover({cleanup:recoverOwnedCatalogTab});}catch{runtime.profileSyncCoordination={status:'RECOVERY_JOURNAL_OR_NETWORK_UNVERIFIED'};}finally{runtime.profileSyncRecoveryRunning=false;}})(),'profileSyncRecovery');
}

async function refreshProfileRegistriesWork() {
  if (runtime.profileSyncRunning || runtime.profileSyncRecoveryRunning || !canClaimCommands()) return;
  runtime.profileSyncRunning = true;
  const roleEpoch = clusterRuntime.lastTransitionAt;
  const isActive = async () => canClaimCommands() && clusterRuntime.lastTransitionAt === roleEpoch;
  let safeRelease = false;
  let attemptedAcquire = false;
  let coordinator;
  try {
    coordinator=createProfileSyncCoordinator();
    if(coordinator.owner){runtime.profileSyncCoordination=await coordinator.recover({cleanup:recoverOwnedCatalogTab});if(coordinator.owner)return;}
    if (!await isActive()) return;
    attemptedAcquire = true;
    safeRelease = true; // This attempt has not launched a collector yet.
    const reservation = await coordinator.acquire(isActive);
    runtime.profileSyncCoordination={...coordinator.summary(),status:reservation.status};
    if (reservation.nextAt) runtime.nextProfileSyncAt = reservation.nextAt;
    if (reservation.status !== 'ACQUIRED') return;
    if (!await coordinator.owns(isActive)) return;
    coordinator.setPhase('collecting');
    safeRelease = false;
    const result = await runProfileSyncOnce({
      isActive: () => coordinator.owns(isActive),
      collectorDeadline: coordinator.deadline - coordinator.marginMs,
      collectorOwnershipJournal: coordinator.collectorJournal,
      reservationOwner: coordinator.owner,
      requireWriteRevision: true,
      dryRun: false,
      drive,
      config: profileSyncConfig(),
      stateRoot: path.join(DATA, 'profile-sync'),
    });
    safeRelease = result.collection_cleanup_verified !== false;
    runtime.profileSync = {
      schema: 'drive-worker-profile-sync-state-v1',
      version: VERSION,
      host: serverName(),
      role: clusterRuntime.role,
      updated_at: new Date().toISOString(),
      result,
    };
    runtime.lastProfileSyncError = null;
    if (await coordinator.owns(isActive)) await drive.upsertJson(STATE_FOLDER_ID, 'profile-sync.json', runtime.profileSync);
  } catch (error) {
    runtime.lastProfileSyncError = String(error?.message || error).slice(0, 1000);
  } finally {
    if(coordinator){if(attemptedAcquire&&safeRelease&&coordinator.owner){try{coordinator.setPhase('cleanup_verified');await coordinator.release();}catch{}}runtime.profileSyncCoordination=coordinator.summary();}
    runtime.profileSyncRunning = false;
  }
}

async function mainLoop() {
  while (!shuttingDown) {
    try {
      void maintainProfileSyncRecovery();
      await refreshClusterRole();
      if (shuttingDown) break;
      if (canClaimCommands() || clusterRuntime.role === 'STANDBY') {
        await pollOnce();
      } else {
        runtime.lastPollAt = new Date().toISOString();
      }
      runtime.lastError = null;
    } catch (error) {
      runtime.lastError = String(error?.message || error).slice(0, 1000);
    }

    if (!shuttingDown && clusterRuntime.role === 'ACTIVE'
        && (!runtime.capabilities || Date.now() >= nextCapabilitiesAt)) {
      await refreshCapabilities();
      nextCapabilitiesAt = Date.now() + CAPABILITIES_REFRESH_MS;
    }

    if (canClaimCommands()
        && !runtime.profileSyncRunning
        && !runtime.profileSyncRecoveryRunning
        && Date.now() >= Number(runtime.nextProfileSyncAt || 0)) {
      runtime.nextProfileSyncAt = Date.now() + PROFILE_SYNC_REFRESH_MS;
      void refreshProfileRegistries();
    }

    if (!shuttingDown) await delay(POLL_MS);
  }
}

const healthServer = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  if (req.url === '/capabilities') {
    res.writeHead(runtime.capabilities ? 200 : 503, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(runtime.capabilities || {
      error: runtime.lastCapabilitiesError || 'capabilities_not_ready',
    }));
    return;
  }
  if (req.url !== '/health') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  const body = {
    ok: true,
    auth: drive.authSnapshot(),
    version: VERSION,
    host: serverName(),
    server_priority: serverPriority(),
    role: clusterRuntime.role,
    active_server: clusterRuntime.activeServer,
    active_priority: clusterRuntime.activePriority,
    cluster_member_timeout_ms: CLUSTER_MEMBER_TIMEOUT_MS,
    claim_ready_at: new Date(clusterRuntime.claimReadyAt || 0).toISOString(),
    claim_ready: canClaimCommands(),
    status: runtime.activeJobs.size ? 'BUSY' : 'IDLE',
    active_job: firstActiveJob(),
    active_jobs: activeJobsSnapshot(),
    max_concurrency: concurrencySnapshot().effective,
    concurrency: concurrencySnapshot(),
    started_at: runtime.startedAt,
    last_poll_at: runtime.lastPollAt,
    last_success_at: runtime.lastSuccessAt,
    last_error: runtime.lastError,
    processed_jobs: runtime.processed,
    cleanup: cleanupSummary(),
    capabilities: capabilitySummary(),
    profile_sync: profileSyncSummary(),
    drain: drainSummary(),
  };
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
});

healthServer.listen(HEALTH_PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({
    event: 'DRIVE_WORKER_READY',
    host: serverName(),
    server_priority: serverPriority(),
    role: clusterRuntime.role,
    active_server: clusterRuntime.activeServer,
    cluster_member_timeout_ms: CLUSTER_MEMBER_TIMEOUT_MS,
    claim_ready_at: new Date(clusterRuntime.claimReadyAt || 0).toISOString(),
    claim_ready: canClaimCommands(),
    port: HEALTH_PORT,
    commandsFolderId: COMMANDS_FOLDER_ID,
    resultsFolderId: RESULTS_FOLDER_ID,
    stateFolderId: STATE_FOLDER_ID,
    skillsFolderId: SKILLS_FOLDER_ID || null,
    capabilitiesRefreshMs: CAPABILITIES_REFRESH_MS,
    profileSyncRefreshMs: PROFILE_SYNC_REFRESH_MS,
    cleanupEnabled: false,
    maxConcurrency: concurrencySnapshot().effective,
    concurrencyMode: concurrencySnapshot().mode,
  }));
});

function shutdown(signal) {
  if (shutdownTask) return shutdownTask;
  shuttingDown = true;
  drainStartedAt = new Date().toISOString();
  if (cpuSamplerTimer) {
    clearInterval(cpuSamplerTimer);
    cpuSamplerTimer = null;
  }
  console.log(JSON.stringify({ event: 'DRIVE_WORKER_DRAIN_REQUESTED', signal }));
  shutdownTask = (async () => {
    // Wait exclusively for jobs still executing. Historical result and
    // publication errors must NEVER block a shutdown with zero active jobs.
    while (runtime.activeJobs.size > 0) {
      await delay(500);
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    const completedAt = new Date().toISOString();
    drainCompletedAt = completedAt;
    const stopping = heartbeat({ status: 'STOPPING', drain: {
      ...drainSummary(), status: 'COMPLETE', completed_at: completedAt,
    } }).catch((error) => {
      console.error(JSON.stringify({ event: 'DRIVE_WORKER_STOPPING_PUBLICATION_WARNING',
        reason: String(error?.message || error).slice(0, 300) }));
    });
    // Publishing STOPPING is best effort; do not stay alive for metadata.
    await Promise.race([stopping, delay(1200)]);
    console.log(JSON.stringify({ event: 'DRIVE_WORKER_DRAIN_COMPLETE', signal,
      active_jobs: runtime.activeJobs.size, historical_failures: publicationFailures.size }));
    healthServer.close(() => {});
    process.exit(process.exitCode || 0);
  })();
  return shutdownTask;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void shutdown(signal); });
}

async function runWorker() {
  await refreshCpuUsageSample();
  if (shuttingDown) return;
  startCpuSampler();
  // Authentication can become ready after the worker. Keep /health available
  // and retry startup rather than entering drain on a recoverable auth state.
  while (!shuttingDown) {
    try {
      await heartbeat({ status: 'STARTING' });
      if (shuttingDown) return;
      startHeartbeatTimer();
      await refreshClusterRole();
      runtime.lastError = null;
      break;
    } catch (error) {
      if (!Object.hasOwn(DriveClient.authStatuses, error?.code)) throw error;
      runtime.lastError = error.code;
      if (!shuttingDown) await delay(POLL_MS);
    }
  }
  if (shuttingDown) return;
  if (clusterRuntime.role === 'ACTIVE') {
    await refreshCapabilities();
  }
  if (shuttingDown) return;
  nextCapabilitiesAt = Date.now() + CAPABILITIES_REFRESH_MS;
  await mainLoop();
}

lifecycleTask = runWorker();
try {
  await lifecycleTask;
} catch (error) {
  runtime.lastError = String(error?.stack || error);
  console.error(runtime.lastError);
  process.exitCode = 1;
} finally {
  await (shutdownTask || shutdown('worker_loop_finished'));
}
