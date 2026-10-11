import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn as childSpawn } from 'node:child_process';

const sourceFile = process.env.DW_TEST_SOURCE || path.join(path.dirname(new URL(import.meta.url).pathname), 'worker.mjs');
const source = await readFile(sourceFile, 'utf8');
const start = source.indexOf('// The local terminal record is authoritative');
const end = source.indexOf('const seenCommandFiles = new Set();', start);
assert.ok(start > 0 && end > start, 'patched block missing');
const block = source.slice(start, end);

class FakeDrive {
  constructor() { this.docs = new Map(); this.seq = 0; this.failFinal = 0; this.failRunning = 0; this.delayedLookup = false; }
  async findByName(_folder, name) {
    if (this.delayedLookup) await new Promise(r=>setTimeout(r,20));
    const x=this.docs.get(name); return x && {id:x.id,name};
  }
  async readText(file) { return this.docs.get(file.name).body; }
  async createBytes(_folder,name,_mime,body) { const x={id:'doc_'+(++this.seq),name,body}; this.docs.set(name,x); return {id:x.id,name}; }
  async updateBytes(id,_mime,body) {
    const entry=[...this.docs.values()].find(x=>x.id===id);
    assert.ok(entry, 'update target exists');
    const status=JSON.parse(body).status;
    if(status==='RUNNING' && this.failRunning-->0) throw new Error('simulated RUNNING publication failed');
    if(['DONE','ERROR','FAILED','TIMED_OUT'].includes(status) && this.failFinal-->0) throw new Error('simulated terminal publication failed');
    entry.body=body;
  }
  async uploadText(_folder,name,body) {
    const x=this.docs.get(name);if(x){x.body=body;return{id:x.id,name};}
    return this.createBytes(null,name,null,body);
  }
  status(jobId){ return this.docs.has(jobId+'.json') ? JSON.parse(this.docs.get(jobId+'.json').body).status : null; }
}
async function harness(options={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'dw-exit-'));
  const drive=options.drive||new FakeDrive();
  const runtime={activeJobs:new Map(),currentChildren:new Map(),processed:0,lastSuccessAt:null,lastError:null};
  const unsettledResults=new Map(), publicationFailures=new Map();
  let count=0;
  const context={
    fs:await import('node:fs/promises'),fss:fs,path,os, process, console,
    spawn:(...a)=>{count++;return childSpawn(...a);},
    setTimeout,clearTimeout,Date,DATA:root,HOME:root,DEFAULT_SHELL:'/bin/bash',
    RESULTS_FOLDER_ID:'fake-results', TERMINAL_RESULT_STATUSES:new Set(['DONE','FAILED','ERROR','TIMED_OUT','INVALID']),
    shuttingDown:false, runtime,unsettledResults,publicationFailures,drive,
    clusterRuntime:{role:'ACTIVE'},canClaimCommands:()=>true,
    commandTargetServer:job=>String(job.target_server||''),
    serverName:()=> 'Galaxy-S25',serverPriority:()=>2,memberIsAlive:options.memberIsAlive||(()=>false),
    commandSummary:(job,file)=>({schema:'drive-worker-result-v1',job_id:job.job_id,command_file_id:file.id,command:job.command}),
    sanitizeOutboundText:s=>s,safeJobName:s=>String(s).replace(/[^A-Za-z0-9._:-]/g,'_'),
    delay:ms=>new Promise(r=>setTimeout(r,ms)),heartbeat:async()=>{},
    terminateChildTree:(child,signal)=>{try{process.kill(-child.pid,signal);}catch{try{child.kill(signal)}catch{}}},
  };
  vm.runInNewContext(block+'\nglobalThis.runJobForTest = runJob;\nglobalThis.publicationRetryAfterForTest = publicationRetryAfter;',vm.createContext(context),{filename:'worker.mjs',timeout:3000});
  const job=(id,cmd='printf ok')=>({job_id:id,command:cmd,target_server:'Galaxy-S25',timeout_ms:3000});
  const file=(id)=>({id:'command_'+id,name:id+'.json'});
  const run=(id,cmd)=>context.runJobForTest(file(id),job(id,cmd));
  const close=()=>rm(root,{recursive:true,force:true});
  return {root,drive,runtime,unsettledResults,publicationFailures,context,job,file,run,close,count:()=>count};
}

test('happy completion releases child, journals and skips replay',async()=>{
 const h=await harness();try{
  const first=await h.run('happy');
  assert.equal(first.result.status,'DONE');
  assert.equal(h.drive.status('happy'),'DONE');
  assert.equal(h.runtime.activeJobs.size,0);
  assert.equal(h.runtime.currentChildren.size,0);
  assert.equal(h.unsettledResults.size,0);
  const local=JSON.parse(await readFile(path.join(h.root,'jobs','happy','terminal-result.json'),'utf8'));
  assert.equal(local.status,'DONE');
  const second=await h.run('happy');
  assert.equal(second.reason,'result_exists');
  assert.equal(h.count(),1);
 }finally{await h.close();}
});

test('final Drive failure removes ghost, retries publication without reexecution',async()=>{
 const h=await harness();try{
  h.drive.failFinal=1;
  const first=await h.run('pub-fail');
  assert.equal(first.reason,'terminal_publication_pending');
  assert.equal(h.runtime.activeJobs.size,0);
  assert.equal(h.runtime.currentChildren.size,0);
  assert.equal(h.drive.status('pub-fail'),'RUNNING');
  assert.equal(h.publicationFailures.size,1);
  assert.equal(h.unsettledResults.size,0);
  h.context.publicationRetryAfterForTest.clear();
  const second=await h.run('pub-fail');
  assert.equal(second.reason,'terminal_result_republished');
  assert.equal(h.drive.status('pub-fail'),'DONE');
  assert.equal(h.count(),1);
  assert.equal(h.publicationFailures.size,0);
 }finally{await h.close();}
});

test('failed RUNNING publication does not abort child or prevent final result',async()=>{
 const h=await harness();try{
  h.drive.failRunning=1;
  const first=await h.run('run-fail');
  assert.equal(first.result.status,'DONE');
  assert.equal(h.count(),1);
  assert.equal(h.runtime.activeJobs.size,0);
  assert.equal(h.drive.status('run-fail'),'DONE');
 }finally{await h.close();}
});

test('restart replays local terminal journal but never command',async()=>{
 const h=await harness();try{
  h.drive.failFinal=1;
  await h.run('restart');
  const h2=await harness({drive:h.drive});
  try{
   const target=path.join(h2.root,'jobs','restart');
   await mkdir(target,{recursive:true});
   for(const f of ['terminal-result.json','execution-accepted.json','stdout.log','stderr.log']){
    await writeFile(path.join(target,f),await readFile(path.join(h.root,'jobs','restart',f)));
   }
   const r=await h2.run('restart');
   assert.equal(r.reason,'terminal_result_republished');
   assert.equal(h2.drive.status('restart'),'DONE');
   assert.equal(h2.count(),0);
  }finally{await h2.close();}
 }finally{await h.close();}
});

test('orphan RUNNING is quarantined and never reexecuted',async()=>{
 const h=await harness();try{
  await h.drive.createBytes(null,'orphan.json',null,JSON.stringify({job_id:'orphan',status:'RUNNING',executor_host:'Galaxy-S25',pid:12345}));
  const r=await h.run('orphan');
  assert.equal(r.reason,'prior_execution_quarantined');
  assert.equal(h.drive.status('orphan'),'ERROR');
  assert.equal(h.count(),0);
  const second=await h.run('orphan');
  assert.equal(second.reason,'result_exists');
 }finally{await h.close();}
});

test('orphan CLAIMED and accepted marker prevent replay',async()=>{
 const h=await harness();try{
  await h.drive.createBytes(null,'claimed.json',null,JSON.stringify({job_id:'claimed',status:'CLAIMED',executor_host:'Galaxy-S25'}));
  assert.equal((await h.run('claimed')).reason,'prior_execution_quarantined');
  assert.equal(h.count(),0);
  const accepted=path.join(h.root,'jobs','accepted-only');
  await mkdir(accepted,{recursive:true});
  await writeFile(path.join(accepted,'execution-accepted.json'),JSON.stringify({job_id:'accepted-only',command_file_id:'command_accepted-only'}));
  assert.equal((await h.run('accepted-only')).reason,'prior_execution_quarantined');
  assert.equal(h.count(),0);
 }finally{await h.close();}
});

test('live peer remains protected',async()=>{
 const h=await harness({memberIsAlive:()=>true});try{
  await h.drive.createBytes(null,'peer.json',null,JSON.stringify({job_id:'peer',status:'RUNNING',executor_host:'Galaxy-Tab-S11-Ultra'}));
  const r=await h.run('peer');
  assert.equal(r.reason,'result_in_progress_on_live_peer');
  assert.equal(h.drive.status('peer'),'RUNNING');
  assert.equal(h.count(),0);
 }finally{await h.close();}
});

test('duplicate concurrent commands are fenced before Drive lookup',async()=>{
 const h=await harness();try{
  h.drive.delayedLookup=true;
  const a=h.run('concurrent');
  const b=h.run('concurrent');
  const second=await b;
  const first=await a;
  assert.equal(second.reason,'job_claim_in_flight');
  assert.equal(first.result.status,'DONE');
  assert.equal(h.count(),1);
 }finally{await h.close();}
});

test('nonzero exit recorded as FAILED and cleanup succeeds',async()=>{
 const h=await harness();try{
  const r=await h.run('nonzero','exit 12');
  assert.equal(r.result.status,'FAILED');
  assert.equal(r.result.exit_code,12);
  assert.equal(h.runtime.activeJobs.size,0);
 }finally{await h.close();}
});

test('execution timeout kills process and releases active child',async()=>{
 const h=await harness();try{
  const j=h.job('timeout','sleep 2');j.timeout_ms=100;
  const r=await h.context.runJobForTest(h.file('timeout'),j);
  assert.equal(r.result.status,'TIMED_OUT');
  assert.equal(h.runtime.activeJobs.size,0);
 }finally{await h.close();}
});
