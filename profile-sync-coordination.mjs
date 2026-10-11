import { randomUUID } from 'node:crypto';
import { FileCoordinationJournal, processIdentity, processEnded, readPrivateJournal } from './profile-sync-recovery.mjs';
import { GoogleDocsRegistryStore } from './profile-registry-sync.mjs';

export const COORDINATION_SCHEMA = 'drive-worker-profile-sync-coordination-v1';
export function initialCoordinationState() {
  return { schema: COORDINATION_SCHEMA, next_at_ms: 0, owner: null, lease_until_ms: 0, generation: 0, recovery: null };
}
function validate(value) {
  return value && Object.keys(value).length===6 && value?.schema === COORDINATION_SCHEMA
    && Number.isSafeInteger(value.next_at_ms) && value.next_at_ms >= 0
    && Number.isSafeInteger(value.lease_until_ms) && value.lease_until_ms >= 0
    && Number.isSafeInteger(value.generation) && value.generation >= 0
    && (value.owner === null || /^[a-zA-Z0-9-]{1,128}$/.test(value.owner))
    && (value.recovery===null || value.recovery?.schema==='profile-sync-owner-recovery-v1');
}

// A single deployment-established Google Doc ID is shared by both nodes.
// No find/create/upsert fallback: missing coordination is a closed prerequisite.
export class ProfileSyncCoordinator {
  constructor({ drive, documentId, store = new GoogleDocsRegistryStore(drive), now = Date.now,
    token = randomUUID, intervalMs = 3600000, leaseMs = 180000, marginMs = 30000, journalPath, journal = journalPath ? new FileCoordinationJournal(journalPath) : null, host, identity = host ? processIdentity() : null, isProcessEnded = processEnded, getCurrentIdentity = processIdentity, readCollectorJournal = readPrivateJournal }) {
    Object.assign(this, { documentId, store, now, token, intervalMs, leaseMs, marginMs, journalPath, journal, host, currentHost:host, identity, isProcessEnded, getCurrentIdentity, readCollectorJournal });
    this.owner = null; this.deadline = 0; this.generation = null; this.phase = 'idle'; this.lastStatus = 'IDLE';
    const pending=this.journal?.read();if(pending?.owner){if(pending.schema!=='profile-sync-pending-owner-v1'||pending.document_id!==documentId)throw Error('PROFILE_SYNC_RECOVERY_JOURNAL_UNVERIFIED');Object.assign(this,{owner:pending.owner,deadline:pending.deadline,generation:pending.generation,phase:pending.phase,identity:pending.identity,host:pending.host,collectorJournal:pending.collector_journal});}
  }
  persist(overrides={}) {
    this.journal?.write({schema:'profile-sync-pending-owner-v1',document_id:this.documentId,owner:this.owner,deadline:this.deadline,generation:this.generation,phase:this.phase,identity:this.identity,host:this.host,collector_journal:this.collectorJournal||null,...overrides});
  }
  setPhase(phase){this.phase=phase;this.persist();}
  clear(){
    const pending=this.journal?.read();
    if(!pending||(pending.document_id===this.documentId&&pending.owner===this.owner&&pending.generation===this.generation)){
      this.persist({owner:null,deadline:0,generation:null,phase:'idle'});
    }
    this.owner=null;this.deadline=0;this.generation=null;this.phase='idle';
  }
  summary(){return {status:this.lastStatus,phase:this.phase,pending_owner:!!this.owner,host:['Galaxy-S25','Galaxy-Tab-S11-Ultra'].includes(this.host)?this.host:null,...(this.blockedOwner||{})};}
  async recover({canRelease,cleanup}={}) {
    if(!this.owner)return {status:'NO_PENDING_OWNER'};
    const current=this.getCurrentIdentity();
    const sameProcess=current&&this.identity&&current.pid===this.identity.pid&&current.start_time===this.identity.start_time&&current.boot_id===this.identity.boot_id;
    let safe=canRelease===true||sameProcess&&['reserved','cleanup_verified','release_pending'].includes(this.phase);
    if(!safe&&(sameProcess||this.isProcessEnded(this.identity))){
      if(['reserved','cleanup_verified','release_pending'].includes(this.phase))safe=true;
      else if(this.collectorJournal){const record=this.readCollectorJournal(this.collectorJournal);
        if(!record)safe=true; // No permit file: an orphan child cannot open a target.
        else if(record.schema==='profile-sync-collector-owner-v1'&&record.owner===this.owner&&record.phase==='launching')safe=true;
        else if(record.schema==='profile-sync-collector-owner-v1'&&record.owner===this.owner&&this.isProcessEnded(record.child)){
          safe=record.phase==='complete_safe'||typeof cleanup==='function'&&await cleanup(record);
        }
      }
    }
    if(!safe){this.lastStatus='RECOVERY_BLOCKED_CLEANUP_UNVERIFIED';return this.summary();}
    try{await this.release();this.lastStatus='RECOVERY_RELEASED';}catch{this.lastStatus='RECOVERY_RELEASE_PENDING';}
    return this.summary();
  }
  async read() {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(this.documentId || '')) throw Error('PROFILE_SYNC_COORDINATION_REQUIRED');
    let state;try{state=await this.store.read(this.documentId);}catch{throw Error('PROFILE_SYNC_COORDINATION_READ_FAILED');}
    if (!validate(state.value) || typeof state.revisionId !== 'string' || !state.revisionId) {
      throw Error('PROFILE_SYNC_COORDINATION_INVALID');
    }
    return state;
  }
  async acquire(isActive) {
    if(this.owner){this.lastStatus='RECOVERY_PENDING';return {status:'RECOVERY_PENDING'};}
    if (!await isActive()) return { status: 'STANDBY_NOOP' };
    const state = await this.read(), now = this.now();
    if (!await isActive()) return { status: 'STANDBY_NOOP' };
    if (state.value.owner !== null || state.value.next_at_ms > now || state.value.lease_until_ms > now) {
      this.lastStatus=state.value.owner!==null?(state.value.lease_until_ms>now?'OWNER_BUSY':'OWNER_RECOVERY_REQUIRED'):'NOT_DUE';
      this.blockedOwner={shared_owner_present:state.value.owner!==null,shared_owner_host:['Galaxy-S25','Galaxy-Tab-S11-Ultra'].includes(state.value.recovery?.host)?state.value.recovery.host:null,shared_lease_expired:state.value.owner!==null&&state.value.lease_until_ms<=now};
      return { status: this.lastStatus, nextAt: state.value.owner !== null && state.value.next_at_ms <= now ? now + this.intervalMs : Math.max(state.value.next_at_ms, state.value.lease_until_ms) };
    }
    if(this.currentHost)this.host=this.currentHost;
    if(this.host){const current=this.getCurrentIdentity();if(!current)throw Error('PROFILE_SYNC_CURRENT_WORKER_IDENTITY_UNVERIFIED');this.identity=current;}
    const owner = this.token();
    const next = { ...state.value, owner, generation: state.value.generation + 1,
      next_at_ms: now + this.intervalMs, lease_until_ms: now + this.leaseMs };
    this.owner=owner;this.generation=next.generation;this.deadline=next.lease_until_ms;this.phase='reserved';
    this.collectorJournal=this.journalPath?this.journalPath.replace(/[^/]+$/, 'collector-'+owner+'.json'):null;
    next.recovery={schema:'profile-sync-owner-recovery-v1',host:this.host||null,worker:this.identity,collector_journal_basename:this.collectorJournal?.split('/').at(-1)||null};
    this.persist(); // Preserve candidate even when CAS/readback has an uncertain outcome.
    // Strict revision CAS. Ambiguous network completion never permits collection.
    try{await this.store.write(this.documentId, next, state);}catch{throw Error('PROFILE_SYNC_RESERVATION_CONFLICT_OR_UNCERTAIN');}
    const observed = await this.read();
    if (!await isActive() || observed.value.owner !== owner || observed.value.generation !== next.generation
        || this.now() >= next.lease_until_ms - this.marginMs) {this.lastStatus='RESERVATION_UNVERIFIED';return {status:this.lastStatus,nextAt:next.next_at_ms};}
    this.lastStatus='ACQUIRED';
    return { status: 'ACQUIRED', nextAt: next.next_at_ms, deadline: this.deadline };
  }
  async owns(isActive) {
    if (!this.owner || !await isActive() || this.now() >= this.deadline - this.marginMs) return false;
    try {
      const state = await this.read();
      return await isActive() && this.now() < this.deadline - this.marginMs
        && state.value.owner === this.owner && state.value.generation === this.generation
        && state.value.lease_until_ms === this.deadline;
    } catch { return false; }
  }
  async release() {
    if (!this.owner) return;
    try {
      this.setPhase('release_pending');
      const state = await this.read();
      if(state.value.owner!==this.owner||state.value.generation!==this.generation){this.clear();return;}
      await this.store.write(this.documentId,{...state.value,owner:null,lease_until_ms:0,recovery:null},state);
      const readback=await this.read();
      if(readback.value.owner===this.owner&&readback.value.generation===this.generation)throw Error('PROFILE_SYNC_RELEASE_UNVERIFIED');
      this.clear();this.lastStatus='RELEASED';
    }catch{this.lastStatus='RECOVERY_RELEASE_PENDING';throw Error('PROFILE_SYNC_RELEASE_PENDING');}
  }
}
