import {createHash} from 'node:crypto';
const digest=s=>createHash('sha256').update(s).digest('hex');
const sets={capabilities:new Set(['host.commands','skills.installed','proot.distributions']),mcp:new Set(['servers','servers.*.tool_names','servers.*.tools'])};
function serviceStatus(value){
 if(typeof value!=='string')return value;
 return value.split(/([;\n])/).map(line=>line.replace(/^(\s*(?:run|down|finish):\s*.+?:\s*)(?:\(pid\s+\d+\)\s*)?(\d+)s(\s*(?:, normally (?:up|down))?)$/,(_,prefix,seconds,suffix)=>prefix+'<process-time>'+suffix)).join('');
}
export function normalizeInventory(kind,value,path=[]){
 const where=path.join('.');
 if(kind==='mcp'&&['servers.*.service_status','servers.*.service_status.stdout'].includes(where)&&typeof value==='string')return serviceStatus(value);
 if(Array.isArray(value)){
  const items=value.map(x=>normalizeInventory(kind,x,[...path,'*']));
  return sets[kind]?.has(where)?items.sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0):items;
 }
 if(value&&typeof value==='object'){
  const result={};
  for(const key of Object.keys(value).sort()){
   if(path.length===0&&(key==='content_hash'||kind==='capabilities'&&key==='detected_at'||kind==='mcp'&&['generated_at','source_generated_at'].includes(key)))continue;
   if(kind==='mcp'&&where==='servers.*'&&key==='last_verified_at')continue;
   if(kind==='mcp'&&where==='servers.*.service_status'&&['pid','elapsed_seconds','uptime_seconds'].includes(key))continue;
   result[key]=normalizeInventory(kind,value[key],[...path,key]);
  }
  return result;
 }
 return value;
}
export function inventoryContentHash(kind,value){return digest(JSON.stringify(normalizeInventory(kind,value)))}
export function inventoryArtifacts(kind,value,markdown){
 const contentHash=inventoryContentHash(kind,value);const body=String(markdown);
 return {contentHash,json:JSON.stringify({...value,content_hash:contentHash},null,2)+'\n',markdown:'<!-- inventory_content_hash: '+contentHash+' -->\n<!-- inventory_payload_hash: '+digest(body)+' -->\n'+body};
}
export function remoteArtifactMatches(kind,format,text,contentHash){
 try{
  if(format==='json'){const value=JSON.parse(text);return value.content_hash===contentHash&&inventoryContentHash(kind,value)===contentHash;}
  const match=String(text).match(/^<!-- inventory_content_hash: ([a-f0-9]{64}) -->\n<!-- inventory_payload_hash: ([a-f0-9]{64}) -->\n/);
  return !!match&&match[1]===contentHash&&match[2]===digest(String(text).slice(match[0].length));
 }catch{return false;}
}
// Read every remote target on every attempt: no local cache can establish remote success.
export async function publishInventoryArtifacts({kind,artifacts,targets,drive,isActive}){
 const results=[];
 for(const target of targets){
  try{
   if(!await isActive())throw Error('INVENTORY_ROLE_EPOCH_CHANGED');
   const metadata=await drive.getMetadata(target.id);
   if(metadata?.id!==target.id||metadata.trashed===true||metadata.mimeType!==target.mimeType)throw Error('INVENTORY_TARGET_UNVERIFIED');
   const current=await drive.readText(metadata);
   if(remoteArtifactMatches(kind,target.format,current,artifacts.contentHash)){results.push({id:target.id,status:'UNCHANGED',content_hash:artifacts.contentHash});continue;}
   if(!await isActive())throw Error('INVENTORY_ROLE_EPOCH_CHANGED');
   await drive.updateBytes(target.id,target.mimeType,target.format==='json'?artifacts.json:artifacts.markdown);
   const observed=await drive.readText(metadata);
   if(!remoteArtifactMatches(kind,target.format,observed,artifacts.contentHash))throw Error('INVENTORY_PUBLICATION_READBACK_FAILED');
   results.push({id:target.id,status:'UPDATED',content_hash:artifacts.contentHash});
  }catch(error){results.push({id:target.id,status:'FAILED',reason:/^INVENTORY_[A-Z_]+$/.test(error?.message||'')?error.message:'INVENTORY_PUBLICATION_FAILED'});}
 }
 return {status:results.every(x=>x.status!=='FAILED')?'VERIFIED':'PARTIAL_OR_FAILED',content_hash:artifacts.contentHash,targets:results};
}
