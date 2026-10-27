import { processEnded } from './profile-sync-recovery.mjs';

const endpoint='http://127.0.0.1:9230';
export async function recoverIndependentTab(record,{ended=processEnded,fetcher=fetch}={}){
  try {
    if(record?.schema!=='profile-sync-collector-owner-v1'||!record.independent||!ended(record.child))return false;
    if(record.phase==='complete_safe')return true;
    if(!record.browser||ended(record.browser))return true;
    const key=new URL(record.browser_key);
    if(key.protocol!=='ws:'||key.hostname!=='127.0.0.1'||key.port!=='9230'||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(key.pathname)||key.search||key.hash)return false;
    const get=async path=>{let r=await fetcher(endpoint+path,{signal:AbortSignal.timeout(4000),redirect:'error'});if(!r.ok)throw Error('HTTP');return await r.json()};
    if((await get('/json/version')).webSocketDebuggerUrl!==record.browser_key)return false;
    const list=await get('/json/list');if(!Array.isArray(list))return false;
    let target;
    if(record.own_target_verified===true) {
      if(!/^[a-zA-Z0-9-]+$/.test(record.own_target_id||''))return false;
      target=list.find(t=>t.id===record.own_target_id);
    } else {
      if(!/^about:blank#profile-sync-[a-zA-Z0-9-]+$/.test(record.bootstrap_url||''))return false;
      let matches=list.filter(t=>t.url===record.bootstrap_url);if(matches.length>1)return false;target=matches[0];
    }
    if(!target)return true;
    const res=await fetcher(endpoint+'/json/close/'+encodeURIComponent(target.id),{signal:AbortSignal.timeout(4000)});if(!res.ok)return false;
    for(let i=0;i<12;i++){let a=await get('/json/list');if(!a.some(x=>x.id===target.id))return true;await new Promise(r=>setTimeout(r,200))}
    return false;
  }catch{return false;}
}
