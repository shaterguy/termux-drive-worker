import test from 'node:test';
import assert from 'node:assert/strict';
import { IndependentCatalogSource, validateLoopbackEndpoint } from './independent-catalog-source.mjs';

test('collects account catalog without checking SelfRun and parses result', async () => {
  const parsed = {profiles:[{id:'p'}]};
  const source = new IndependentCatalogSource({
    isActive: async () => true,
    collect: async ({onCleanup}) => { onCleanup(true); return {status:'ok'}; },
    parser: input => { assert.equal(input.status,'ok'); return parsed; }
  });
  assert.equal(await source.canWrite(), true);
  assert.deepEqual(await source.fetch(), parsed);
  assert.equal(source.cleanupVerified, true);
});
test('inactive owner never collects or publishes', async () => {
  let called = 0;
  const source = new IndependentCatalogSource({
    isActive: async () => false,
    collect: async () => { called++; },
    parser: x => x
  });
  assert.equal(await source.canWrite(), false);
  await assert.rejects(source.fetch(), /ACTIVE_ROLE_LOST/);
  assert.equal(called,0);
});
test('only local debugging endpoints are allowed', () => {
  assert.equal(validateLoopbackEndpoint('http://127.0.0.1:9230'), true);
  for (const v of ['http://example.com:9230','http://127.0.0.1:9230@evil.test','https://127.0.0.1:9230','http://localhost:9230','http://127.0.0.1:9230/x']) assert.equal(validateLoopbackEndpoint(v),false);
});

test('recovery closes only its verified target in the original browser', async () => {
 const {recoverIndependentTab}=await import('./independent-catalog-recovery.mjs');
 let targets=[{id:'ours'},{id:'other'}],closed=[];
 const record={schema:'profile-sync-collector-owner-v1',independent:true,phase:'target_verified',child:{pid:9},browser:{pid:1},browser_key:'ws://127.0.0.1:9230/devtools/browser/xyz',own_target_verified:true,own_target_id:'ours'};
 const fetcher=async url=>{
  if(url.endsWith('/json/version'))return {ok:true,json:async()=>({webSocketDebuggerUrl:record.browser_key})};
  if(url.endsWith('/json/list'))return {ok:true,json:async()=>targets};
  if(url.includes('/json/close/')){let id=decodeURIComponent(url.split('/').at(-1));closed.push(id);targets=targets.filter(x=>x.id!==id);return {ok:true};}
  throw Error('unexpected URL');
 };
 const ended=x=>x?.pid===9;
 assert.equal(await recoverIndependentTab(record,{ended,fetcher}),true);
 assert.deepEqual(closed,['ours']);assert.deepEqual(targets,[{id:'other'}]);
});
test('recovery never closes targets when browser identity is different', async () => {
 const {recoverIndependentTab}=await import('./independent-catalog-recovery.mjs');
 const record={schema:'profile-sync-collector-owner-v1',independent:true,phase:'target_verified',child:{pid:9},browser:{pid:1},browser_key:'ws://127.0.0.1:9230/devtools/browser/original',own_target_verified:true,own_target_id:'ours'};
 let calls=[];
 const fetcher=async url=>{calls.push(url);return {ok:true,json:async()=>({webSocketDebuggerUrl:'ws://127.0.0.1:9230/devtools/browser/replacement'})}};
 assert.equal(await recoverIndependentTab(record,{ended:x=>x?.pid===9,fetcher}),false);
 assert.equal(calls.length,1);
});

test('failed catalog collection is not reported as a completed refresh', async () => {
 const {runProfileSyncOnce}=await import('./profile-sync-runtime.mjs');
 const bad={fetch:async()=>{throw Error('offline')},canWrite:async()=>true,cleanupVerified:true};
 const result=await runProfileSyncOnce({
   active:true,isActive:async()=>true,dryRun:true,drive:{},store:{},stateStore:{read:async()=>null},
   sources:{CHAT:bad,WORK:bad},
   config:{schema:'selfrun-profile-sync-runtime-v1',enabled:true,dry_run:true,registries:{CHAT:{document_id:'a'},WORK:{document_id:'b'}}}
 });
 assert.equal(result.status,'INCOMPLETE');
 assert.equal(result.results.CHAT.status,'SOURCE_FAILED');
 assert.equal(result.results.WORK.status,'SOURCE_FAILED');
});

test('standalone browser receives Termux temporary directory', async () => {
 const {collectorEnvironment}=await import('./independent-catalog-source.mjs');
 assert.equal(collectorEnvironment().TMPDIR,'/data/data/com.termux/files/usr/tmp');
});
test('recovery accepts the existing logged-in browser on the alternate local port', async () => {
 const {recoverIndependentTab}=await import('./independent-catalog-recovery.mjs');
 const record={schema:'profile-sync-collector-owner-v1',independent:true,phase:'target_verified',child:{pid:9},browser:{pid:1},debug_port:19227,browser_key:'ws://127.0.0.1:19227/devtools/browser/xyz',own_target_verified:true,own_target_id:'ours'};
 let calls=[];
 const fetcher=async url=>{calls.push(url);return {ok:true,json:async()=>url.endsWith('/json/version')?{webSocketDebuggerUrl:record.browser_key}:[]}};
 assert.equal(await recoverIndependentTab(record,{ended:x=>x?.pid===9,fetcher}),true);
 assert.ok(calls.every(url=>url.startsWith('http://127.0.0.1:19227/')));
});

test('collector opts into the dedicated VNC account profile without exposing other environment variables', async () => {
 const {collectorEnvironment}=await import('./independent-catalog-source.mjs');
 const options=collectorEnvironment({MODEL_SYNC_CHROMIUM_PROFILE:'vnc',SECRET:'do-not-pass'});
 assert.equal(options.MODEL_SYNC_CHROMIUM_PROFILE,'vnc');
 assert.equal(options.SECRET,undefined);
 assert.equal(collectorEnvironment({MODEL_SYNC_CHROMIUM_PROFILE:'unexpected'}).MODEL_SYNC_CHROMIUM_PROFILE,undefined);
});
