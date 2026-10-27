import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { processIdentity,processEnded,readPrivateJournal,writePrivateJournal } from './profile-sync-recovery.mjs';
import { projectWorkCatalog } from './profile-work-catalog-projector.mjs';
import { projectCatalog } from './profile-chat-collector.mjs';

const HOME='/data/data/com.termux/files/home';
const ENDPOINT='http://127.0.0.1:9230';
const profile=HOME+'/.config/chromium';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function opt(name){return process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3);}
async function json(endpoint,init={}) {
  const r=await fetch(ENDPOINT+endpoint,{...init,signal:AbortSignal.timeout(4000),redirect:'error'});
  if(!r.ok)throw Error('BROWSER_HTTP_'+r.status);
  return await r.json();
}
function browserProc() {
  for(const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))) {
    try {let a=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0');
      if(a.includes('--user-data-dir='+profile)&&a.includes('--remote-debugging-port=9230')&&!a.some(v=>v.startsWith('--type=')))return processIdentity(Number(pid));
    }catch{}
  }
  return null;
}
async function browserVersion() {
  let p=browserProc();if(!p)throw Error('BROWSER_PROCESS_UNVERIFIED');
  let v=await json('/json/version'),u=new URL(v.webSocketDebuggerUrl);
  if(u.protocol!=='ws:'||u.hostname!=='127.0.0.1'||u.port!=='9230'||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(u.pathname)||u.search||u.hash)throw Error('BROWSER_IDENTITY_UNVERIFIED');
  return {process:p,key:v.webSocketDebuggerUrl};
}
class Session {
 constructor(url){this.url=url;this.seq=0;this.pending=new Map();}
 async connect(){this.ws=new WebSocket(this.url);await new Promise((resolve,reject)=>{let tm=setTimeout(()=>reject(Error('WEBSOCKET_TIMEOUT')),5000);this.ws.addEventListener('open',()=>{clearTimeout(tm);resolve()},{once:true});this.ws.addEventListener('error',()=>{clearTimeout(tm);reject(Error('WEBSOCKET_ERROR'))},{once:true});});this.ws.addEventListener('message',e=>{let j;try{j=JSON.parse(e.data)}catch{return}let p=this.pending.get(j.id);if(p){this.pending.delete(j.id);clearTimeout(p.timer);j.error?p.reject(Error('CDP_ERROR')):p.resolve(j.result)}});}
 call(method,params={}){let id=++this.seq;return new Promise((resolve,reject)=>{let timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP_TIMEOUT'))},10000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
 close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('CDP_CLOSED'));}this.pending.clear();this.ws?.close();}
}
async function permit() {
 const file=opt('ownership-journal'),owner=opt('reservation-owner'),deadline=Number(opt('lease-deadline-ms'));
 if(!file||!file.startsWith(HOME+'/.drive-worker/profile-sync/collector-')||! /^[a-zA-Z0-9-]+$/.test(owner||'')||!Number.isSafeInteger(deadline)||Date.now()>=deadline)throw Error('PERMIT_INVALID');
 const me=processIdentity();
 for(let i=0;i<60;i++){try{const j=readPrivateJournal(file);if(j?.schema==='profile-sync-collector-owner-v1'&&j.owner===owner&&j.phase==='permitted'&&j.child?.pid===me.pid&&j.child?.start_time===me.start_time&&j.child?.boot_id===me.boot_id)return {file,owner,deadline,record:j};}catch{} await sleep(50)}
 throw Error('PERMIT_UNVERIFIED');
}
function record(patch){state.record={...state.record,...patch};writePrivateJournal(state.file,state.record);}
let state,spawnedBrowser;
async function startBrowser() {
 try{return { ...(await browserVersion()), started:false };}catch(e){
   if(browserProc())throw e;
   // Chromium's own profile lock prevents taking over a profile in use on another port.
   const executable='/data/data/com.termux/files/usr/lib/chromium/chrome';
   const child=spawn(executable,['--user-data-dir='+profile,'--remote-debugging-port=9230','--headless=new','--no-sandbox','--disable-gpu','about:blank'],{env:{...process.env,HOME},stdio:'ignore'});
   child.on('error',()=>{});
   spawnedBrowser=child;
   const identity=processIdentity(child.pid);if(!identity)throw Error('BROWSER_START_UNVERIFIED');
   record({phase:'browser_starting',independent:true,owned_browser:identity});
   for(let i=0;i<40;i++){if(Date.now()>=state.deadline)throw Error('LEASE_EXPIRED');try{let b=await browserVersion();if(b.process.pid!==identity.pid)throw Error('BROWSER_NOT_OWNED');let tabs=await json('/json/list');let initial=tabs.find(t=>t.url==='about:blank');return {...b,started:true,child,initialTargetId:initial?.id}}catch{await sleep(250)}}
   throw Error('BROWSER_START_FAILED');
 }
}
let page,tab,browser,closed=false,stopped=false;
async function cleanup(){
 if(page){page.close();page=null}
 if(browser&&state?.record?.phase==='creation_pending'&&!tab?.id){
   try {let list=await json('/json/list');let matches=list.filter(x=>x.url===state.record.bootstrap_url);if(matches.length>1)return false;if(matches.length===1)tab={id:matches[0].id};else closed=true;}catch{return false}
 }
 if(tab?.id&&/^[a-zA-Z0-9-]+$/.test(tab.id)){
   try{let v=await browserVersion();if(v.key!==browser.key)return false;
       let list=await json('/json/list');
       if(!list.some(x=>x.id===tab.id))closed=true;
       else {let r=await fetch(ENDPOINT+'/json/close/'+encodeURIComponent(tab.id),{signal:AbortSignal.timeout(4000)});if(!r.ok)return false;
         for(let i=0;i<12;i++){list=await json('/json/list');if(!list.some(x=>x.id===tab.id)){closed=true;break}await sleep(200)}}
   }catch{return false}
 } else if(!browser||state?.record?.phase!=='creation_pending')closed=true;
 if(!browser&&spawnedBrowser&&state?.record?.owned_browser){
   const identity=state.record.owned_browser;
   if(!processEnded(identity)){spawnedBrowser.kill('SIGTERM');for(let i=0;i<20&&!processEnded(identity);i++)await sleep(100);if(!processEnded(identity))return false;}
 }
 if(browser?.started){
   try{let list=await json('/json/list');let onlyOwnBlank=list.length===0||(list.length===1&&list[0].id===browser.initialTargetId&&list[0].url==='about:blank');if(onlyOwnBlank&&browserProc()?.pid===browser.process.pid){browser.child.kill('SIGTERM');for(let i=0;i<20&&!processEnded(browser.process);i++)await sleep(100);if(!processEnded(browser.process))return false;}}catch{return false}
 }
 return closed;
}
process.once('SIGTERM',()=>{stopped=true;});
try{
 state=await permit();
 const kind=opt('catalog-kind');if(!['CHAT','WORK'].includes(kind))throw Error('CATALOG_KIND_INVALID');
 browser=await startBrowser();
 const marker='about:blank#profile-sync-'+randomUUID();
 record({phase:'creation_pending',independent:true,browser:browser.process,browser_key:browser.key,bootstrap_url:marker,debug_port:9230});
 const r=await fetch(ENDPOINT+'/json/new?'+encodeURIComponent(marker),{method:'PUT',signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error('TAB_CREATE_FAILED');tab=await r.json();
 if(!/^[a-zA-Z0-9-]+$/.test(tab.id||''))throw Error('TARGET_INVALID');
 let u=new URL(tab.webSocketDebuggerUrl);if(u.protocol!=='ws:'||u.hostname!=='127.0.0.1'||u.port!=='9230'||u.pathname!=='/devtools/page/'+tab.id||u.search||u.hash)throw Error('TARGET_URL_INVALID');
 record({phase:'target_verified',own_target_verified:true,own_target_id:tab.id});
 page=new Session(tab.webSocketDebuggerUrl);await page.connect();await page.call('Page.enable');await page.call('Runtime.enable');
 await page.call('Page.navigate',{url:'https://chatgpt.com/'});
 let ready=false;for(let i=0;i<80;i++){if(stopped||Date.now()>=state.deadline)throw Error('PERMIT_EXPIRED');try{const v=await page.call('Runtime.evaluate',{expression:"location.origin === 'https://chatgpt.com' && document.readyState !== 'loading'",returnByValue:true});if(v.result?.value===true){ready=true;break}}catch{}await sleep(250)}
 if(!ready)throw Error('PAGE_NOT_READY');
 const route=kind==='WORK'?'/backend-api/tpp/models/':'/backend-api/models?supports_model_picker_upgrade_presets=true';
 const expression=`(async()=>{const s=await fetch('/api/auth/session',{credentials:'include',signal:AbortSignal.timeout(10000)});if(!s.ok)return {error:'SESSION_HTTP'};const a=await s.json();if(typeof a.accessToken!=='string')return {error:'LOGIN_REQUIRED'};const r=await fetch(${JSON.stringify(route)},{headers:{Authorization:'Bearer '+a.accessToken},credentials:'include',signal:AbortSignal.timeout(12000)});if(!r.ok)return {error:'CATALOG_HTTP_'+r.status};return {catalog:await r.json()};})()`;
 let data=await page.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
 if(stopped||Date.now()>=state.deadline)throw Error('PERMIT_EXPIRED');
 const v=data.result?.value;if(v?.error)throw Error(v.error);
 const projected=(kind==='WORK'?projectWorkCatalog:projectCatalog)(v?.catalog);
 let safe=await cleanup();if(!safe)throw Error('TAB_CLEANUP_UNVERIFIED');
 record({phase:'complete_safe'});console.log(JSON.stringify({...projected,own_tab_cleanup:'closed'}));
}catch(e){
 const safe=state?await cleanup().catch(()=>false):true;
 if(safe&&state)try{record({phase:'complete_safe'})}catch{}
 console.log(JSON.stringify({status:'independent_catalog_failed',error:String(e?.message||e).slice(0,150),own_tab_cleanup:safe?'closed':'unknown'}));
}
