import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {processIdentity,processEnded,readPrivateJournal,writePrivateJournal} from './profile-sync-recovery.mjs';
import {projectWorkCatalog} from './profile-work-catalog-projector.mjs';

export function projectCatalog(data) {
  const type=x=>x===null?'null':Array.isArray(x)?'array':typeof x;
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const id=x=>typeof x==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(x);
  const label=x=>typeof x==='string'&&[...x].length<=100&&!/\p{Cc}/u.test(x)&&!/[\uD800-\uDFFF]/u.test(x)&&!/(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.test(x);
  const issues=[];let issueCount=0,criticalIssueCount=0,optionalIssueCount=0;
  const issue=(path,x)=>{issueCount++;const optional=/^versions\[\d+\]\.id$/.test(path)||/(?:\.)(?:title|selected_display_title|full_label|short_label|mobile_full_label|display_text|display_name|label|name)$/.test(path);if(optional)optionalIssueCount++;else criticalIssueCount++;if(issues.length<48)issues.push({path,type:type(x)});};
  const describe=x=>({type:type(x),...(Array.isArray(x)?{count:x.length}:{})});
  const schema={top_level_type:type(data),top_level_fields:object(data)?['models','versions','categories'].filter(k=>Object.hasOwn(data,k)).slice(0,48).map(k=>({key:k,...describe(data[k])})):[],issues,issue_count:0};
  // Explicit null is copied; absent remains absent with a separate field-state record.
  const field=(src,dst,key,valid,path)=>{
    const states=dst.field_states??={};
    if(!Object.hasOwn(src,key)){states[key]={state:'absent'};return;}
    const value=src[key];states[key]={state:'present',type:type(value)};
    if(value===null||valid(value))dst[key]=value;else issue(path+'.'+key,value);
  };
  const models=[],versions=[],categories=[],work=new Set();
  if(!object(data))issue('$',data);
  const rows=(value,path,limit=256)=>{if(value===undefined)return [];if(!Array.isArray(value)){issue(path,value);return [];}if(value.length>limit)issue(path+'.length',value.length);return value.slice(0,limit);};
  for(const [i,m] of rows(data?.models,'models').entries()){
    const path='models['+i+']';if(!object(m)||!id(m.slug)){issue(path+'.slug',m?.slug);continue;}
    if(m.is_work_mode_model===true){work.add(m.slug);continue;}
    const row={slug:m.slug,source_index:i};
    field(m,row,'title',label,path);
    for(const key of ['enabled','disabled','hidden','is_hidden','is_admin_only','admin_only','disabled_by_admin'])field(m,row,key,x=>typeof x==='boolean',path);
    field(m,row,'tags',x=>Array.isArray(x)&&x.length<=128&&x.every(id),path);
    for(const key of ['default_thinking_effort','reasoning_type'])field(m,row,key,id,path);
    field(m,row,'is_work_mode_model',x=>typeof x==='boolean',path);
    field(m,row,'configurable_thinking_effort',x=>typeof x==='boolean',path);
    field(m,row,'thinking_efforts',Array.isArray,path);
    if(Array.isArray(row.thinking_efforts))row.thinking_efforts=rows(row.thinking_efforts,path+'.thinking_efforts',128).flatMap((e,j)=>{
      const ep=path+'.thinking_efforts['+j+']';
      if(e===null||id(e))return [e];
      if(!object(e)){issue(ep,e);return [];}
      const effort={source_index:j};field(e,effort,'thinking_effort',id,ep);
      for(const key of ['display_text','display_name','label','name','title','selected_display_title','full_label','short_label','mobile_full_label'])field(e,effort,key,label,ep);
      return [effort];
    });
    models.push(row);
  }
  for(const [i,v] of rows(data?.versions,'versions').entries()){
    const path='versions['+i+']';if(!object(v)){issue(path,v);continue;}
    const row={source_index:i};if(id(v.id))row.id=v.id;else if(Object.hasOwn(v,'id'))issue(path+'.id',v.id);field(v,row,'display_text',label,path);
    for(const key of ['enabled','disabled','hidden','is_hidden','is_admin_only','admin_only','disabled_by_admin'])field(v,row,key,x=>typeof x==='boolean',path);
    field(v,row,'tags',x=>Array.isArray(x)&&x.length<=128&&x.every(id),path);
    field(v,row,'slugs',Array.isArray,path);
    if(Array.isArray(row.slugs))row.slugs=rows(row.slugs,path+'.slugs',128).filter((s,j)=>{if(!id(s)){issue(path+'.slugs['+j+']',s);return false;}return !work.has(s);});
    field(v,row,'intelligence_presets',Array.isArray,path);
    if(Array.isArray(row.intelligence_presets))row.intelligence_presets=rows(row.intelligence_presets,path+'.intelligence_presets',128).flatMap((p,j)=>{
      const pp=path+'.intelligence_presets['+j+']';if(!object(p)){issue(pp,p);return [];}
      if(work.has(p.model_slug))return [];
      const preset={source_index:j};for(const key of ['enabled','disabled','hidden','is_hidden','is_admin_only','admin_only','disabled_by_admin'])field(p,preset,key,x=>typeof x==='boolean',pp);field(p,preset,'tags',x=>Array.isArray(x)&&x.length<=128&&x.every(id),pp);for(const key of ['model_slug','thinking_effort','preset_type','lane'])field(p,preset,key,id,pp);
      for(const key of ['display_text','display_name','label','name','title','selected_display_title','full_label','short_label','mobile_full_label'])field(p,preset,key,label,pp);
      // Upstream preset_type is authoritative; absence of effort implies no availability judgment.
      if(p.preset_type==='upgrade')preset.projection_classification='upgrade_offer';
      return [preset];
    });
    if(Array.isArray(v.slugs)&&v.slugs.length>0&&row.slugs?.length===0&&(!row.intelligence_presets||row.intelligence_presets.length===0))continue;
    versions.push(row);
  }
  for(const [i,c] of rows(data?.categories,'categories').entries()){
    const path='categories['+i+']';if(!object(c)){issue(path,c);continue;}
    const category={source_index:i};
    for(const key of ['category','default_model','model_lane','model_version'])field(c,category,key,id,path);
    field(c,category,'supported_models',x=>Array.isArray(x)&&x.length<=256&&x.every(id),path);
    for(const key of ['enabled','disabled','hidden','is_hidden','admin_only','is_admin_only','disabled_by_admin','is_soft_deprecated'])field(c,category,key,x=>typeof x==='boolean',path);
    field(c,category,'tags',x=>Array.isArray(x)&&x.length<=128&&x.every(id),path);
    categories.push(category);
  }
  schema.issue_count=issueCount;schema.critical_issue_count=criticalIssueCount;schema.optional_issue_count=optionalIssueCount;
  return {status:models.length||versions.length?(issueCount?'ok_partial':'ok'):'schema_unrecognized',source:'ordinary_models_response',models,versions,categories,schema};
}

const DEVICE_HOME='/data/data/com.termux/files/home';
export function deviceIdentity() {
  try{return fs.readFileSync(DEVICE_HOME+'/SERVER_NAME','utf8').trim()===TARGET_SERVER&&CONTEXT_VALID;}catch{return false;}
}
function matchesExtensionProof(j,row,boot) {
  const p=j?.process,profile=DEVICE_HOME+'/.config/chromium',extension=DEVICE_HOME+'/.selfrun-server/browser-extension';
  return j?.schema==='selfrun-extension-ownership-v1'&&j.profile===profile&&typeof j.ownerId==='string'&&j.ownerId.length>0&&j.controllerStopPending===false&&!j.retiringProcess&&p&&Number.isSafeInteger(p.pid)&&p.pid>0&&p.profile===profile&&p.extensionPath===extension&&p.ownerId===j.ownerId&&p.cdpPort===19227&&p.bootId===boot&&typeof boot==='string'&&boot.length>0&&row&&row.pid===p.pid&&!['Z','X'].includes(row.state)&&row.startTime===p.startTime&&row.args.includes('--user-data-dir='+profile)&&row.args.includes('--load-extension='+extension)&&row.args.includes('--selfrun-extension-owner='+j.ownerId)&&row.args.includes('--remote-debugging-port=19227')&&row.args.includes('--remote-debugging-address=127.0.0.1')&&!row.args.some(x=>x.startsWith('--type='));
}
export function ownedListener() {
  try {
    const raw=fs.readFileSync(DEVICE_HOME+'/.selfrun-server/extension-ownership.json','utf8');
    if(raw.length>262144)return null;const j=JSON.parse(raw),p=j.process;
    if(!Number.isSafeInteger(p?.pid)||p.pid<=0)return null;
    const stat=fs.readFileSync('/proc/'+p.pid+'/stat','utf8');
    const f=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
    const row={pid:p.pid,state:f[0],startTime:f[19],args:fs.readFileSync('/proc/'+p.pid+'/cmdline','utf8').split('\0').filter(Boolean)};
    const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    if(!matchesExtensionProof(j,row,boot))return null;
    const w=new URL(p.browserKey);
    if(w.protocol!=='ws:'||w.hostname!=='127.0.0.1'||w.port!=='19227'||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(w.pathname)||w.search||w.hash)return null;
    return p.browserKey;
  } catch{return null;}
}


let SOURCE_HASHES={"src/browser/chatgpt.mjs": "4540cb3d3ae454a8d96e90f51a831b32c6ce13074a42857ee1f82de6ecbf2f72", "src/browser/cdp.mjs": "fbd4fd79240b6a681f102600383e8613b2a82a1145f2f2d80da9e0809a4d934c", "src/config.mjs": "389a80b1be9c383f63220b8417ea9f62b8a956d11a7f30f63571dacc84919439", "src/lifecycle.mjs": "812cf6dc2af599b7353877e9da3ffd548da1ed565214538e08985b8d5ab67413", "src/prompt-directives.mjs": "f914d8dd83e1eb4d61f2ebc88b649dd6cae0a8edc47ff20058d93e7321875481", "src/browser/extension-profile-bootstrap.mjs": "f6fbd6a67a94b5cbb9eb083ba1726b6b95bd08aee2b542c81df295f4e2ee6cf5"};

// Requires independently verified live-server public profile settings; no guessing worker defaults.
let EXPECTED_PRODUCTION_PROFILE_FINGERPRINT='a9d7d32e83eeca710be826e55e77b557ae913b473f4c9b69fd6fdbece3a54e58';
let ROOT=DEVICE_HOME+'/work/selfrun-done-4d6fe4a-tablet-20261007/termux-server';
// Verified public settings apply only to this diagnostic child process.
let PRODUCTION_PROFILE_ENV={"SELFRUN_BROWSER_ADAPTER":"extension","SELFRUN_BROWSER_CLIENT_PROFILE":"android-webview","SELFRUN_EXTENSION_PROFILE_BOOTSTRAP":"cdp-emulation","SELFRUN_EXTENSION_BRIDGE_PORT":"17832","SELFRUN_BROWSER_PORT":"19227","SELFRUN_BROWSER_PROFILE":"/data/data/com.termux/files/home/.config/chromium","SELFRUN_BROWSER_ANDROID_USER_AGENT":"","SELFRUN_BROWSER_ANDROID_MODEL":"SM-S931N","SELFRUN_BROWSER_ANDROID_VERSION":"17","SELFRUN_BROWSER_ANDROID_PLATFORM_VERSION":"17.0.0","SELFRUN_BROWSER_ANDROID_BUILD_ID":"BP4A.251205.006","SELFRUN_BROWSER_ANDROID_CHROME_VERSION":"149.0.7827.155","SELFRUN_BROWSER_ANDROID_ACCEPT_LANGUAGE":"ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7","SELFRUN_BROWSER_ANDROID_WIDTH":"412","SELFRUN_BROWSER_ANDROID_HEIGHT":"915","SELFRUN_BROWSER_ANDROID_DPR":"3"};
const CONTEXT_FILE=new URL('./profile-chat-context.json',import.meta.url);
let TARGET_SERVER='Galaxy-Tab-S11-Ultra',CONTEXT_VALID=true;
export function validateCollectorContext(value){
  const keys=['schema','target_server','selfrun_root','source_hashes','profile_fingerprint','profile_environment'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k))||value.schema!=='normal-chat-collector-context-v1'||!['Galaxy-Tab-S11-Ultra','Galaxy-S25'].includes(value.target_server))return false;
  if(typeof value.selfrun_root!=='string'||!value.selfrun_root.startsWith(DEVICE_HOME+'/work/')||!value.selfrun_root.endsWith('/termux-server')||value.selfrun_root.length>512||! /^[a-zA-Z0-9_./-]+$/.test(value.selfrun_root)||value.selfrun_root.split('/').includes('..'))return false;
  if(typeof value.profile_fingerprint!=='string'||! /^[a-f0-9]{64}$/.test(value.profile_fingerprint))return false;
  for(const [candidate,known] of [[value.source_hashes,SOURCE_HASHES],[value.profile_environment,PRODUCTION_PROFILE_ENV]])if(!candidate||typeof candidate!=='object'||Array.isArray(candidate)||Object.keys(candidate).length!==Object.keys(known).length||Object.keys(known).some(k=>!Object.hasOwn(candidate,k)||typeof candidate[k]!=='string'||candidate[k].length>1024||/[\x00-\x1f\x7f]/.test(candidate[k])))return false;
  if(Object.values(value.source_hashes).some(h=>! /^[a-f0-9]{64}$/.test(h)))return false;
  return value.profile_environment.SELFRUN_BROWSER_ADAPTER==='extension'&&value.profile_environment.SELFRUN_BROWSER_CLIENT_PROFILE==='android-webview'&&value.profile_environment.SELFRUN_EXTENSION_PROFILE_BOOTSTRAP==='cdp-emulation'&&value.profile_environment.SELFRUN_EXTENSION_BRIDGE_PORT==='17832'&&value.profile_environment.SELFRUN_BROWSER_PORT==='19227'&&value.profile_environment.SELFRUN_BROWSER_PROFILE===DEVICE_HOME+'/.config/chromium';
}
// Only a deployment-reviewed public context adjacent to this updater module can select another node/root.
try{const stat=fs.lstatSync(CONTEXT_FILE);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384||stat.uid!==process.getuid())throw Error('context');const value=JSON.parse(fs.readFileSync(CONTEXT_FILE,'utf8'));if(!validateCollectorContext(value))throw Error('context');TARGET_SERVER=value.target_server;ROOT=value.selfrun_root;SOURCE_HASHES=value.source_hashes;EXPECTED_PRODUCTION_PROFILE_FINGERPRINT=value.profile_fingerprint;PRODUCTION_PROFILE_ENV=value.profile_environment;}catch(error){if(error?.code!=='ENOENT')CONTEXT_VALID=false;}

export function selectPublicProfileEnvironment(chunks, keys = Object.keys(PRODUCTION_PROFILE_ENV)) {
  const allowed = new Set(keys), out = {};let key=[],value=[],selected=false,readingKey=true,total=0;
  for (const chunk of chunks) for (const byte of chunk) {
    if (++total > 262144) throw Error('environment budget');
    if (byte === 0) { if(selected)out[Buffer.from(key).toString('ascii')]=Buffer.from(value).toString('utf8');key=[];value=[];selected=false;readingKey=true;continue; }
    if (readingKey) { if(byte===61){selected=allowed.has(Buffer.from(key).toString('ascii'));readingKey=false;}else if(key.length<128)key.push(byte);else throw Error('key budget'); }
    else if(selected){if(value.length>=1024)throw Error('public field budget');value.push(byte);}
  }
  if(key.length||value.length||!readingKey)throw Error('incomplete environment');return out;
}
function* publicEnvironmentChunks(file,io=fs){const fd=io.openSync(file,'r');try{const buffer=Buffer.alloc(1024);let n;while((n=io.readSync(fd,buffer,0,buffer.length,null))>0)yield buffer.subarray(0,n);}finally{io.closeSync(fd);}}
export function matchesLiveProfile(live, expectedRoot=ROOT, expectedEnvironment=PRODUCTION_PROFILE_ENV, allowMissingDefaults=false) {
  return live?.root===expectedRoot && typeof live.identity==='string' && Object.entries(expectedEnvironment).every(([key,value]) =>
    live.environment?.[key]===value || (value==='' || allowMissingDefaults) && !Object.hasOwn(live.environment||{},key));
}
export function liveServerProfile(io=fs,uid=process.getuid()) {
  try {
    const candidates=[];
    for(const entry of io.readdirSync('/proc')){
      if(!/^[0-9]+$/.test(entry))continue;
      try {
        const base='/proc/'+entry,status=io.readFileSync(base+'/status','utf8');
        if(Number(status.match(/^Uid:\s+(\d+)/m)?.[1])!==uid||!io.readlinkSync(base+'/exe').endsWith('/node'))continue;
        const argv=io.readFileSync(base+'/cmdline');if(argv.length>65536)continue;
        const parts=[];let at=0;for(let end;(end=argv.indexOf(0,at))>=0;at=end+1)parts.push(argv.subarray(at,end));
        const argument=parts[1]?.equals(Buffer.from('--no-warnings'))?parts[2]:parts[1];
        if(!argument||argument.length>1024||![...argument].every(b=>b>=32&&b<=126))continue;
        const candidate=argument.toString('ascii');if(!candidate.endsWith('/termux-server/src/server.mjs')&&!['src/server.mjs','./src/server.mjs'].includes(candidate))continue;
        const cwd=io.readlinkSync(base+'/cwd'),entryPath=io.realpathSync(new URL(candidate.startsWith('/')?'file://'+candidate:'file://'+cwd+'/'+candidate));
        if(!entryPath.startsWith(DEVICE_HOME+'/work/')||!entryPath.endsWith('/termux-server/src/server.mjs'))continue;
        const root=entryPath.slice(0,-'/src/server.mjs'.length),raw=io.readFileSync(base+'/stat','utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
        if(['Z','X'].includes(fields[0]))continue;
        const parentPid=Number(fields[1]);if(!Number.isSafeInteger(parentPid)||parentPid<=0)continue;
        const parentBase='/proc/'+parentPid,parentStatus=io.readFileSync(parentBase+'/status','utf8');
        if(Number(parentStatus.match(/^Uid:\s+(\d+)/m)?.[1])!==uid)continue;
        const parentExe=io.readlinkSync(parentBase+'/exe').split('/').at(-1);if(!['bash','sh'].includes(parentExe))continue;
        const parentRaw=io.readFileSync(parentBase+'/stat','utf8'),parentFields=parentRaw.slice(parentRaw.lastIndexOf(')')+2).trim().split(/\s+/);
        if(['Z','X'].includes(parentFields[0]))continue;
        const environment=selectPublicProfileEnvironment(publicEnvironmentChunks(base+'/environ',io),[...Object.keys(PRODUCTION_PROFILE_ENV),'SELFRUN_SERVER_PORT']);
        if(Object.hasOwn(environment,'SELFRUN_SERVER_PORT')&&environment.SELFRUN_SERVER_PORT!=='17831')continue;
        const again=io.readFileSync(base+'/stat','utf8'),f=again.slice(again.lastIndexOf(')')+2).trim().split(/\s+/);
        if(f[19]!==fields[19]||!argv.equals(io.readFileSync(base+'/cmdline')))continue;
        const parentAgain=io.readFileSync(parentBase+'/stat','utf8'),pa=parentAgain.slice(parentAgain.lastIndexOf(')')+2).trim().split(/\s+/);
        if(pa[19]!==parentFields[19]||['Z','X'].includes(pa[0]))continue;
        candidates.push({root,environment,identity:entry+':'+fields[19]+':'+parentPid+':'+parentFields[19],proof_kind:'same_uid_process_lineage_root_profile_health_browser_journal',socket_binding_verified:false});
      }catch{}
    }
    return candidates.length===1?candidates[0]:null;
  }catch{return null;}
}
function liveServerMatches(){return matchesLiveProfile(liveServerProfile(),ROOT,PRODUCTION_PROFILE_ENV,true);}
const deadlineArgument=process.argv.find(arg=>arg.startsWith('--lease-deadline-ms='));
const LEASE_DEADLINE=deadlineArgument&&/^[0-9]{13}$/.test(deadlineArgument.slice('--lease-deadline-ms='.length))?Number(deadlineArgument.slice('--lease-deadline-ms='.length)):deadlineArgument?0:Infinity;
const ownershipArgument=process.argv.find(arg=>arg.startsWith('--ownership-journal='));
const OWNERSHIP_JOURNAL=ownershipArgument?.slice('--ownership-journal='.length);
const RESERVATION_OWNER=process.argv.find(arg=>arg.startsWith('--reservation-owner='))?.slice('--reservation-owner='.length);
function validJournalPath(file){return typeof file==='string'&&file.startsWith(DEVICE_HOME+'/')&&file.length<1024&&/^[a-zA-Z0-9_./-]+$/.test(file)&&!file.split('/').includes('..')&&/collector-[a-zA-Z0-9-]+\.json$/.test(file);}
let COLLECTOR_RECORD=null;
async function verifyCollectorPermit(){
  if(!OWNERSHIP_JOURNAL)return !ownershipArgument;
  if(!validJournalPath(OWNERSHIP_JOURNAL)||! /^[a-zA-Z0-9-]{1,128}$/.test(RESERVATION_OWNER||''))return false;
  const me=processIdentity(),until=Date.now()+3000;
  while(Date.now()<until){try{const record=readPrivateJournal(OWNERSHIP_JOURNAL);if(record?.schema==='profile-sync-collector-owner-v1'&&record.owner===RESERVATION_OWNER&&record.phase==='permitted'&&record.child?.pid===me?.pid&&record.child?.start_time===me.start_time&&record.child?.boot_id===me.boot_id){COLLECTOR_RECORD=record;return true;}}catch{return false;}await new Promise(resolve=>setTimeout(resolve,50));}
  return false;
}
function recordCollector(fields){if(!OWNERSHIP_JOURNAL||!COLLECTOR_RECORD)return;COLLECTOR_RECORD={...COLLECTOR_RECORD,...fields};writePrivateJournal(OWNERSHIP_JOURNAL,COLLECTOR_RECORD);}
export async function recoverOwnedCatalogTab(record,{ended=processEnded,owner=ownedListener,get=localJson,load=loadProduction}={}){
  try{
    if(record?.schema!=='profile-sync-collector-owner-v1'||!ended(record.child))return false;
    if(['launching','permitted','complete_safe'].includes(record.phase))return true;
    if(ended(record.browser))return true;
    if(owner()!==record.browser_key||! /^http:\/\/127\.0\.0\.1:17832\/bootstrap\/[a-zA-Z0-9-]+$/.test(record.bootstrap_url||''))return false;
    const tabs=await get('/json/list');if(!Array.isArray(tabs))return false;
    let target=record.own_target_verified===true?tabs.find(t=>t.id===record.own_target_id):null;
    if(record.own_target_verified===true&&!target)return true;
    if(!target){const matches=tabs.filter(t=>t.type==='page'&&t.url===record.bootstrap_url);if(matches.length!==1)return false;target=matches[0];}
    if(! /^[a-zA-Z0-9-]+$/.test(target.id))return false;
    const production=await load();const session=new production.Session(record.browser_key);try{await connect(session);await session.call('Target.closeTarget',{targetId:target.id},{timeoutMs:4000});const after=await get('/json/list');return Array.isArray(after)&&!after.some(t=>t.id===target.id);}finally{session.close();}
  }catch{return false;}
}
export async function loadProduction(root=ROOT){
  const live=liveServerProfile();if(!matchesLiveProfile(live,root,PRODUCTION_PROFILE_ENV,true))throw Error('live profile mismatch');
  // Compute effective config from the actual live public environment and pinned source defaults.
  for(const key of [...Object.keys(PRODUCTION_PROFILE_ENV),'SELFRUN_SERVER_PORT']){delete process.env[key];if(Object.hasOwn(live.environment,key))process.env[key]=live.environment[key];}
  for(const [file,expected] of Object.entries(SOURCE_HASHES)){const b=fs.readFileSync(root+'/'+file);if(createHash('sha256').update(b).digest('hex')!==expected)throw Error('source mismatch');}
  const [{CdpSession},{applyExtensionClientProfile,extensionProfileFingerprint},{config}]=await Promise.all([import(pathToFileURL(root+'/src/browser/cdp.mjs')),import(pathToFileURL(root+'/src/browser/extension-profile-bootstrap.mjs')),import(pathToFileURL(root+'/src/config.mjs'))]);
  if(config.port!==17831)throw Error('live server configured port mismatch');
  return {Session:CdpSession,applyProfile:applyExtensionClientProfile,fingerprint:extensionProfileFingerprint,config};
}
async function localJson(resource,port=19227){const r=await fetch('http://127.0.0.1:'+port+resource,{redirect:'error',signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error('http');const raw=await r.text();if(raw.length>1048576)throw Error('size');return JSON.parse(raw);}
export async function idle(){if(!CONTEXT_VALID||Date.now()>=LEASE_DEADLINE||!liveServerMatches())return false;try{const h=await localJson('/health',17831);return h.ok===true&&h.status==='IDLE'&&h.cluster?.server_name===TARGET_SERVER&&h.browser_adapter==='extension'&&h.browser_runtime?.adapter==='extension'&&h.browser_runtime.connected===true&&h.browser_runtime.pending===0&&h.browser_runtime.profileConnections===0&&h.browser_runtime.profileContinuityUnverified===false&&h.browser_runtime.profileBootstrap==='cdp-emulation';}catch{return false;}}
function allowedConfig(c){return c?.browserClientProfile==='android-webview'&&c.extensionProfileBootstrap==='cdp-emulation'&&c.browserAdapter==='extension'&&c.extensionBridgePort===17832&&c.browserPort===19227&&c.browserProfile===DEVICE_HOME+'/.config/chromium';}
async function connect(s){let timer;try{await Promise.race([s.connect(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('connect timeout')),3000);})]);}finally{clearTimeout(timer);}}
export async function diagnostic({device=deviceIdentity,owner=ownedListener,isIdle=idle,get=localJson,load=loadProduction,windowMs=30000,expectedProfileFingerprint=EXPECTED_PRODUCTION_PROFILE_FINGERPRINT,catalogKind='CHAT'}={}){
  const initialLiveIdentity=isIdle===idle?liveServerProfile()?.identity:null;
  const originalIdle=isIdle;isIdle=async()=>await originalIdle()&&(initialLiveIdentity==null||liveServerProfile()?.identity===initialLiveIdentity);
  if(!device())return {status:'device_identity_unverified'};
  const key=owner();if(!key)return {status:'extension_owner_or_endpoint_unverified'};
  if(!await isIdle())return {status:'idle_server_unverified'};
  let production;try{production=await load();}catch{return {status:'verified_production_modules_unavailable'};}
  if(!allowedConfig(production.config))return {status:'production_android_config_not_available_in_worker',configuration_source:'deployed_config_module_worker_environment'};
  if(typeof expectedProfileFingerprint!=='string'||! /^[a-f0-9]{64}$/.test(expectedProfileFingerprint))return {status:'production_profile_configuration_unverified',normal_profile_function:'applyExtensionClientProfile'};
  if(production.fingerprint(production.config)!==expectedProfileFingerprint)return {status:'production_profile_configuration_mismatch'};
  let browser,page,ownId,ownTargetVerified=false,cleanup='not_required',timer,idleMonitor,out,profileCalls=0,lease=null,profileLost=false,idleLost=false,workBindingStatus='not_attempted';
  const setupAbort=new AbortController();let finishObservation=null,checkingIdle=false;
  const stop=()=>{idleLost=true;setupAbort.abort();finishObservation?.({status:'selfrun_idle_changed'});};
  const onSignal=()=>stop();process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
  idleMonitor=setInterval(()=>{if(checkingIdle)return;checkingIdle=true;void isIdle().then(ok=>{if(!ok)stop();}).catch(stop).finally(()=>{checkingIdle=false;});},500);
  const bootstrapOrigin='http://127.0.0.1:17832',bootstrapUrl=bootstrapOrigin+'/bootstrap/'+randomUUID();
  const call=(s,m,p={},timeoutMs=4000)=>{const cleanup=m==='Target.closeTarget';if(!cleanup&&(Date.now()>=LEASE_DEADLINE||idleLost))throw Error('permit lost');return s.call(m,p,{timeoutMs,...(cleanup?{}:{signal:setupAbort.signal})});};
  try{
    const v=await get('/json/version');if(v.webSocketDebuggerUrl!==key)return {status:'extension_endpoint_changed'};
    browser=new production.Session(key);await connect(browser);
    if(!await isIdle()||owner()!==key)return {status:'idle_or_owner_changed'};
    const browserProof=OWNERSHIP_JOURNAL?JSON.parse(fs.readFileSync(DEVICE_HOME+'/.selfrun-server/extension-ownership.json','utf8')):{process:{pid:process.pid}};
    recordCollector({phase:'creation_pending',bootstrap_url:bootstrapUrl,browser_key:key,browser:processIdentity(browserProof.process.pid),own_target_verified:false});
    cleanup='creation_uncertain';
    const created=await call(browser,'Target.createTarget',{url:bootstrapUrl,background:true});ownId=created.targetId;cleanup='pending';
    if(typeof ownId!=='string'||!/^[a-zA-Z0-9-]+$/.test(ownId))throw Error('target');
    let t;const bootstrapUntil=Date.now()+5000;while(Date.now()<bootstrapUntil){const ts=await get('/json/list');t=Array.isArray(ts)?ts.find(t=>t.id===ownId):null;if(t?.url===bootstrapUrl)break;await new Promise(r=>setTimeout(r,100));}
    if(t?.url!==bootstrapUrl)throw Error('bootstrap document');ownTargetVerified=true;recordCollector({phase:'target_verified',own_target_id:ownId,own_target_verified:true});const w=new URL(t?.webSocketDebuggerUrl);
    if(w.protocol!=='ws:'||w.hostname!=='127.0.0.1'||w.port!=='19227'||w.pathname!=='/devtools/page/'+ownId)throw Error('target');
    page=new production.Session(w.href);await connect(page);
    // Exact production extension-profile bootstrap; its independent setup session is retained.
    lease=await production.applyProfile({target:{id:ownId,bootstrapUrl},config:production.config,signal:AbortSignal.any([AbortSignal.timeout(15000),setupAbort.signal]),bootstrapOrigin,guard:()=>owner()===key&&!!ownId&&!profileLost&&!idleLost,onLost:()=>{profileLost=true;}});
    profileCalls=lease.cdpCommands;if(profileCalls!==3||lease.mode!=='android-webview'||!lease.isAlive())throw Error('profile lease');
    let resolve;
    const observed=new Promise(r=>{resolve=r;});let request=null,finished=false,flag='absent';
    const finish=x=>{if(finished)return;finished=true;clearTimeout(timer);resolve(x);};finishObservation=finish;
    if(idleLost)throw Error('idle changed');
    page.on('Network.responseReceived',p=>{
      if(request!==null||!['Fetch','XHR'].includes(p.type))return;
      try{const u=new URL(p.response?.url);if(u.origin!=='https://chatgpt.com'||!(catalogKind==='WORK'?/^\/backend-api\/tpp\/models\/?$/:/^\/backend-api\/models\/?$/).test(u.pathname))return;const flags=u.searchParams.getAll('supports_model_picker_upgrade_presets');flag=flags.length===0?'absent':flags.length===1&&['true','false'].includes(flags[0])?flags[0]:'unknown';request=p.requestId;if(p.response.status!==200)finish({status:p.response.status===401||p.response.status===403?'catalog_access_denied':'catalog_http_error',http_status:Number.isInteger(p.response.status)?p.response.status:null});}catch{}
    });
    page.on('Network.loadingFailed',p=>{if(p.requestId===request)finish({status:'catalog_request_failed'});});
    page.on('Network.loadingFinished',p=>{if(p.requestId!==request||finished)return;void(async()=>{try{if(p.encodedDataLength>1048576)return finish({status:'catalog_too_large'});const b=await call(page,'Network.getResponseBody',{requestId:request});if(b.base64Encoded||typeof b.body!=='string'||b.body.length>1048576)return finish({status:'catalog_body_unsupported'});finish((catalogKind==='WORK'?projectWorkCatalog:projectCatalog)(JSON.parse(b.body)));}catch{finish({status:'catalog_projection_failed'});}})();});
    // Passive catalog observation only. No application request-profile interception or submission initialization.
    await call(page,'Page.enable');await call(page,'Network.enable',{maxTotalBufferSize:2097152,maxResourceBufferSize:1048576});
    if(!await isIdle()||owner()!==key)throw Error('idle');
    timer=setTimeout(()=>finish({status:'ordinary_catalog_not_observed'}),windowMs);
    const nav=await call(page,'Page.navigate',{url:'https://chatgpt.com/'});if(nav?.errorText)finish({status:'page_navigation_failed'});
    if(catalogKind==='WORK'){
      if(!await isIdle()||owner()!==key)throw Error('permit lost');
      const expression=`(async()=>{const deadline=${Number.isSafeInteger(LEASE_DEADLINE)?LEASE_DEADLINE:Date.now()+90000};const until=Math.min(Date.now()+15000,deadline);while((location.origin!=="https://chatgpt.com"||document.readyState==="loading")&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,100));if(location.origin!=="https://chatgpt.com")return {status:"owned_document_origin_unverified"};const module=await import("https://chatgpt.com/cdn/assets/4813494d-jqntewaek0iw84w5.js");const client=module.T5,auth=module.Tit;if(Date.now()>=deadline||typeof client?.safeGet!=="function"||auth?.SendIfAvailable===undefined)return {status:"frontend_request_binding_unavailable"};void client.safeGet("/tpp/models/",{authOption:auth.SendIfAvailable,parameters:{query:{supports_model_picker_upgrade_presets:true}}}).catch(()=>{});return {status:"frontend_work_catalog_get_started"};})()`;
      // Home initialization can independently deliver the same allowlisted catalog GET.
      // Binding failure must not terminate that existing observation window.
      try {
        const binding=await call(page,'Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},20000);
        const status=binding?.result?.value?.status;
        workBindingStatus=['frontend_work_catalog_get_started','owned_document_origin_unverified','frontend_request_binding_unavailable'].includes(status)?status:'frontend_request_binding_unverified';
      } catch { workBindingStatus='frontend_request_binding_evaluation_failed'; }

    }
    out=await observed;if(idleLost||!await isIdle())out={status:'selfrun_idle_changed'};if(profileLost||!lease.isAlive())out={status:'production_profile_session_lost'};
    out={...out,...(catalogKind==='WORK'?{frontend_work_binding_status:workBindingStatus}:{}),upgrade_presets_flag:flag,normal_profile_function:'applyExtensionClientProfile',inner_profile_function:'applyBrowserClientProfile',profile_commands:profileCalls,profile_session_retained:!profileLost&&lease.isAlive(),configuration_source:'deployed_config_module_worker_environment',live_server_profile_values_match:'verified_fingerprint',live_server_proof_kind:'same_uid_process_lineage_root_profile_health_browser_journal',socket_binding_verified:false,observation_window_ms:windowMs};
  }catch{out={status:'diagnostic_failed_closed',profile_commands:profileCalls};}
  finally{
    clearTimeout(timer);clearInterval(idleMonitor);process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);
    // Keep the production profile-bearing session attached until own-tab closure is attempted.
    if(browser&&cleanup!=='not_required'){
      try {
        if(!ownTargetVerified){ownId=null;const tabs=await get('/json/list');const matches=Array.isArray(tabs)?tabs.filter(t=>t.type==='page'&&t.url===bootstrapUrl&&typeof t.id==='string'&&/^[a-zA-Z0-9-]+$/.test(t.id)):[];
          if(matches.length===1){ownId=matches[0].id;ownTargetVerified=true;cleanup='pending';}else cleanup=matches.length===0?'creation_unverified':'ambiguous_own_target';}
        if(ownId){for(let attempt=0;attempt<2;attempt++){try{const closed=await call(browser,'Target.closeTarget',{targetId:ownId});cleanup=closed.success===true?'closed':'failed';}catch{cleanup='failed';}
          if(cleanup==='closed')break;const tabs=await get('/json/list');if(Array.isArray(tabs)&&!tabs.some(t=>t.id===ownId)){cleanup='closed';break;}}}
      }catch{cleanup='failed';}
    }
    lease?.release();page?.close();browser?.close();
  }
  return {...out,own_tab_cleanup:cleanup};
}

// The existing updater runs this file in a separate child process. Imports never launch collection.
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(new URL(import.meta.url))){
 const warn=console.warn;console.warn=()=>{};let out;try{if(!await verifyCollectorPermit())out={status:'collector_permit_unverified'};else {const kind=process.argv.find(arg=>arg.startsWith('--catalog-kind='))?.slice(15)||'CHAT';if(!['CHAT','WORK'].includes(kind))out={status:'catalog_kind_rejected',own_tab_cleanup:'not_required'};else out=await diagnostic({catalogKind:kind});}}catch{out={status:'diagnostic_failed_closed'};}finally{console.warn=warn;}
 try{const safe=out?.own_tab_cleanup==='closed'||out?.own_tab_cleanup==='not_required'||['collector_permit_unverified','device_identity_unverified','extension_owner_or_endpoint_unverified','idle_server_unverified','verified_production_modules_unavailable','production_android_config_not_available_in_worker','production_profile_configuration_unverified','production_profile_configuration_mismatch','extension_endpoint_changed','idle_or_owner_changed'].includes(out?.status);recordCollector({phase:safe?'complete_safe':'cleanup_unverified'});}catch{}
 const raw=JSON.stringify(out);console.log(raw.length<=131072?raw:JSON.stringify({status:'projected_metadata_too_large',own_tab_cleanup:out?.own_tab_cleanup??'unknown'}));
}
