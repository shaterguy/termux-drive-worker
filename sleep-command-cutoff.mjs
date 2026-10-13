import { readFile } from 'node:fs/promises';

export const FENCE_SCHEMA = 'drive-worker-resume-fence-v1';

function timestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ? ms : null;
}

export async function loadResumeFence(file, modeFile, expectedServer) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') return { kind: 'RETRY', reason: 'fence_read_failed' };
    try {
      const mode = JSON.parse(await readFile(modeFile, 'utf8'));
      if (mode.state === 'resuming' && mode.requested_mode === 'normal') {
        return { kind: 'RETRY', reason: 'resume_fence_not_committed' };
      }
    } catch (modeError) {
      if (modeError.code !== 'ENOENT') return { kind: 'RETRY', reason: 'power_mode_unverified' };
    }
    return { kind: 'NONE' };
  }
  try {
    const fence = JSON.parse(raw);
    const cutoffMs = timestamp(fence.resumed_at);
    if (fence.schema !== FENCE_SCHEMA || fence.server_name !== expectedServer ||
        cutoffMs === null || !Number.isSafeInteger(fence.command_sequence) ||
        fence.command_sequence < 1 || !/^[0-9a-f]{32}$/.test(fence.operation_id)) {
      return { kind: 'RETRY', reason: 'resume_fence_invalid' };
    }
    return { kind: 'READY', cutoffMs, operation_id: fence.operation_id, resumed_at: fence.resumed_at };
  } catch {
    return { kind: 'RETRY', reason: 'resume_fence_invalid' };
  }
}

export function classifyCommandAdmission(fence, commandMetadata, originMetadata, options = {}) {
  if (fence.kind === 'NONE') return { allowed: true, reason: 'no_resume_fence' };
  if (fence.kind !== 'READY') return { allowed: false, retry_later: true, reason: fence.reason || 'fence_unavailable' };

  // A routed copy is never a new admission. Always verify the source file's
  // provider metadata instead of trusting the new copy's creation time.
  const effective = originMetadata || commandMetadata;
  if (!effective || !effective.id || effective.trashed ||
      !Array.isArray(commandMetadata?.parents) ||
      !options.commandsFolderId || !commandMetadata.parents.includes(options.commandsFolderId)) {
    return { allowed: false, retry_later: true, reason: 'command_metadata_unavailable' };
  }
  const createdMs = timestamp(effective.createdTime);
  if (createdMs === null) {
    return { allowed: false, retry_later: true, reason: 'command_creation_time_unavailable' };
  }

  // A producer may stamp the Commands-folder admission instant at the move.
  // Never infer this instant from mutable modifiedTime. Without an admission
  // stamp, the original provider createdTime is the conservative bound.
  const admittedAt = effective.appProperties?.dw_commands_admitted_at;
  const admittedMs = admittedAt == null ? null : timestamp(admittedAt);
  if (admittedAt != null && (admittedMs === null || admittedMs < createdMs)) {
    return { allowed: false, retry_later: true, reason: 'admission_timestamp_invalid' };
  }
  const receivedMs = admittedMs ?? createdMs;
  const nowMs = options.nowMs ?? Date.now();
  const maxFutureMs = options.maxFutureMs ?? 300000;
  if (receivedMs > nowMs + maxFutureMs || fence.cutoffMs > nowMs + maxFutureMs) {
    return { allowed: false, retry_later: true, reason: 'clock_skew_unverified' };
  }
  if (receivedMs <= fence.cutoffMs) {
    return {
      allowed: false, retry_later: false, reason: 'before_resume_cutoff',
      received_at: new Date(receivedMs).toISOString(),
      cutoff_at: fence.resumed_at,
      admission_basis: admittedMs == null ? 'provider_createdTime_conservative' : 'commands_admission_stamp',
    };
  }
  return {
    allowed: true, reason: 'after_resume_cutoff',
    received_at: new Date(receivedMs).toISOString(),
    admission_basis: admittedMs == null ? 'provider_createdTime' : 'commands_admission_stamp',
  };
}

