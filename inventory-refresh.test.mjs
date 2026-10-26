import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('./worker.mjs',import.meta.url),'utf8');
const refresh=source.slice(source.indexOf('function refreshCapabilities()'),source.indexOf('async function refreshCapabilitiesWork()'));
const loop=source.slice(source.indexOf('async function mainLoop()'),source.indexOf('const healthServer ='));
const boot=source.slice(source.indexOf('async function runWorker()'),source.indexOf('lifecycleTask = runWorker();'));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
function harness(){
 const work=deferred();let calls=0,polls=0,iterations=0,entered=0;const operations=new Map();
 const c={console,Date,Promise,setTimeout,clearTimeout,shuttingDown:false,runtime:{capabilities:null,lastCapabilitiesError:null,nextProfileSyncAt:Infinity},clusterRuntime:{role:'ACTIVE'},CAPABILITIES_REFRESH_MS:300000,PROFILE_SYNC_REFRESH_MS:3600000,POLL_MS:1,
 refreshCapabilitiesWork:()=>{calls++;return work.promise},trackOperation:(p,k)=>{operations.set(p,k);p.then(()=>operations.delete(p),()=>operations.delete(p));return p},
 maintainProfileSyncRecovery:()=>{},refreshClusterRole:async()=>{},canClaimCommands:()=>!c.shuttingDown&&c.clusterRuntime.role==='ACTIVE',pollOnce:async()=>{polls++},delay:async()=>{if(++iterations>=2)c.shuttingDown=true},
 refreshProfileRegistries:()=>{},refreshCpuUsageSample:async()=>{},startCpuSampler:()=>{},heartbeat:async()=>{},startHeartbeatTimer:()=>{},DriveClient:{authStatuses:{}}
 };
 vm.createContext(c);vm.runInContext('let capabilitiesRefreshPromise=null;let nextCapabilitiesAt=0;'+refresh+loop+boot+';globalThis.api={refreshCapabilities,mainLoop,runWorker,getNext:()=>nextCapabilitiesAt};',c);
 return{c,work,operations,calls:()=>calls,polls:()=>polls,entered:()=>entered,setMain:()=>vm.runInContext('mainLoop=async()=>{globalThis.entered=true;shuttingDown=true;}',c)}
}
const completeSoon=p=>Promise.race([p.then(()=>true),new Promise(r=>setTimeout(()=>r(false),60))]);
test('poll loop continues while inventory publication is unresolved',async()=>{const h=harness();const p=h.c.api.mainLoop();try{assert.equal(await completeSoon(p),true);assert.equal(h.polls(),2);assert.equal(h.calls(),1)}finally{h.c.shuttingDown=true;h.work.resolve(null);await p}});
test('inventory refresh is single flight and remains tracked',async()=>{const h=harness();try{const a=h.c.api.refreshCapabilities(),b=h.c.api.refreshCapabilities();assert.equal(a,b);await Promise.resolve();assert.equal(h.calls(),1);assert.deepEqual([...h.operations.values()],['refreshCapabilities']);h.work.resolve(null);await a;assert.equal(h.operations.size,0);assert.ok(h.c.api.getNext()>Date.now()+299000)}finally{h.work.resolve(null)}});
test('failed inventory refresh is contained and may be retried',async()=>{const h=harness();const p=h.c.api.refreshCapabilities();h.work.reject(Error('inventory offline'));assert.equal(await p,null);assert.equal(h.c.runtime.lastCapabilitiesError,'inventory offline');assert.equal(h.operations.size,0)});
test('shutdown prevents new inventory work',async()=>{const h=harness();h.c.shuttingDown=true;assert.equal(await h.c.api.refreshCapabilities(),null);assert.equal(h.calls(),0)});
test('startup enters polling before first inventory finishes',async()=>{const h=harness();h.setMain();const p=h.c.api.runWorker();try{assert.equal(await completeSoon(p),true);assert.equal(h.c.entered,true);assert.equal(h.calls(),1)}finally{h.c.shuttingDown=true;h.work.resolve(null);await p}});
