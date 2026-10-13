import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadResumeFence, classifyCommandAdmission, FENCE_SCHEMA } from './sleep-command-cutoff.mjs';
const at = (iso) => iso;
const cutoff='2026-10-13T01:00:00.000Z';
const meta=(when,extra={})=>({id:'original',createdTime:when,parents:['commands'],...extra});
const live={kind:'READY',cutoffMs:Date.parse(cutoff),resumed_at:cutoff,operation_id:'0123456789abcdef0123456789abcdef'};
const dec=(m,origin,nowMs=Date.parse(cutoff)+60000)=>classifyCommandAdmission(live,m,origin,{commandsFolderId:'commands',nowMs});

test('before sleep and during sleep commands excluded, no global Result required',()=>{
 for(const t of ['2026-10-12T23:59:00.000Z','2026-10-13T00:59:59.999Z',cutoff]){
  const r=dec(meta(t));
  assert.equal(r.allowed,false);
  assert.equal(r.reason,'before_resume_cutoff');
 }
});

test('command received just after wake is accepted; normal restart retains cutoff',()=>{
 assert.equal(dec(meta('2026-10-13T01:00:00.001Z')).allowed,true);
 assert.equal(dec(meta('2026-10-13T01:00:00.001Z')).allowed,true);
});

test('later folder move is admitted only with explicit admission receipt, never modifiedTime',()=>{
 const old=meta('2026-10-12T23:20:00.000Z',{modifiedTime:'2026-10-13T01:20:00.000Z'});
 assert.equal(dec(old).allowed,false);
 const moved=meta(old.createdTime,{appProperties:{dw_commands_admitted_at:'2026-10-13T01:00:07.000Z'}});
 assert.equal(dec(moved).allowed,true);
 const prior=meta(old.createdTime,{appProperties:{dw_commands_admitted_at:'2026-10-13T00:59:59.999Z'}});
 assert.equal(dec(prior).allowed,false);
});

test('routed command retains original source age rather than new copy creation time',()=>{
 const child=meta('2026-10-13T01:00:20.000Z',{id:'routed_copy'});
 assert.equal(dec(child,meta('2026-10-13T00:59:00.000Z')).allowed,false);
 assert.equal(dec(child,meta('2026-10-13T01:00:01.000Z')).allowed,true);
});

test('missing metadata and clock skew fail closed and retry',()=>{
 assert.equal(dec(null).retry_later,true);
 assert.equal(dec(meta('2026-10-13T01:00:01.000Z',{parents:['other']})).retry_later,true);
 assert.equal(dec(meta('bad-date')).retry_later,true);
 assert.equal(dec(meta('2026-10-13T02:00:00.000Z')).reason,'clock_skew_unverified');
 assert.equal(dec(meta('2026-10-13T01:01:00.000Z',{appProperties:{dw_commands_admitted_at:'invalid'}})).retry_later,true);
});

test('independent Galaxy-S25 and Galaxy-Tab-S11-Ultra fences survive restart and repeated wake',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'fence-test-'));
 try {
  const mode=path.join(root,'power-mode.json');
  const a=path.join(root,'S25.json');
  const b=path.join(root,'TAB.json');
  const payload=(name,epoch,seq)=>JSON.stringify({schema:FENCE_SCHEMA,server_name:name,resumed_at:epoch,command_sequence:seq,operation_id:'0123456789abcdef0123456789abcdef'});
  await writeFile(a,payload('Galaxy-S25',cutoff,11));
  await writeFile(b,payload('Galaxy-Tab-S11-Ultra','2026-10-12T00:00:00.000Z',4));
  const phone=await loadResumeFence(a,mode,'Galaxy-S25');
  const tablet=await loadResumeFence(b,mode,'Galaxy-Tab-S11-Ultra');
  assert.equal(phone.cutoffMs,Date.parse(cutoff));
  assert.equal(tablet.cutoffMs,Date.parse('2026-10-12T00:00:00.000Z'));
  assert.equal(dec(meta('2026-10-13T00:30:00.000Z')).allowed,false);
  assert.equal(classifyCommandAdmission(tablet,meta('2026-10-13T00:30:00.000Z'),null,{commandsFolderId:'commands',nowMs:Date.parse(cutoff)}).allowed,true);
  await writeFile(a,payload('Galaxy-S25','2026-10-13T02:00:00.000Z',12));
  assert.equal((await loadResumeFence(a,mode,'Galaxy-S25')).cutoffMs,Date.parse('2026-10-13T02:00:00.000Z'));
  assert.equal((await loadResumeFence(b,mode,'Galaxy-Tab-S11-Ultra')).cutoffMs,tablet.cutoffMs);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('resume without persistent fence blocks execution and invalid fence never disables guard',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'fence-mode-'));
 try{
  const state=path.join(root,'fence.json');
  const mode=path.join(root,'mode.json');
  await writeFile(mode,JSON.stringify({state:'resuming',requested_mode:'normal'}));
  assert.equal((await loadResumeFence(state,mode,'Galaxy-S25')).kind,'RETRY');
  await writeFile(state,'bad-json');
  assert.equal((await loadResumeFence(state,mode,'Galaxy-S25')).kind,'RETRY');
  await writeFile(mode,JSON.stringify({state:'normal',requested_mode:'normal'}));
  assert.equal((await loadResumeFence(state,mode,'Galaxy-S25')).kind,'RETRY');
  await rm(state);
  assert.equal((await loadResumeFence(state,mode,'Galaxy-S25')).kind,'NONE');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('metadata or route source read failure does not waive an existing resume fence',()=>{
 assert.equal(classifyCommandAdmission({kind:'RETRY',reason:'fence_unavailable'},meta(cutoff),null,{commandsFolderId:'commands'}).allowed,false);
 assert.equal(dec(meta(cutoff),{}).retry_later,true);
});

