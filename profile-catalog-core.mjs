import {createHash} from 'node:crypto';
import {buildProfile,validateRegistry,validateSnapshot} from './profile-registry-sync.mjs';

const scalar=x=>typeof x==='string'&&!/[\p{Cs}]/u.test(x);
const fail=reason=>{throw Error(reason);};
export function canonicalJson(value){
 if(value===null||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='string'){if(!scalar(value))fail('CANONICAL_SURROGATE');return JSON.stringify(value);}
 if(typeof value==='number'){if(!Number.isSafeInteger(value))fail('CANONICAL_INTEGER');return Object.is(value,-0)?'0':String(value);}
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 if(!value||typeof value!=='object')fail('CANONICAL_SHAPE');
 return '{'+Object.keys(value).sort().map(key=>canonicalJson(key)+':'+canonicalJson(value[key])).join(',')+'}';
}
export const canonicalDigest=value=>createHash('sha256').update(canonicalJson(value),'utf8').digest('hex');

// JSON.parse alone silently accepts duplicate keys. Scan only structure/keys before parsing.
export function parseUniqueJson(raw){
 if(typeof raw!=='string'||Buffer.byteLength(raw)>1048576)fail('JSON_BUDGET');
 const text=raw.replace(/^\uFEFF/, '');let at=0;
 const space=()=>{while(/[\t\r\n ]/.test(text[at]??'')&&at<text.length)at++;};
 const string=()=>{if(text[at++]!=='"')fail('JSON_STRING');const start=at-1;while(at<text.length){const c=text[at++];if(c==='"')return JSON.parse(text.slice(start,at));if(c==='\\'){at++;}else if(c<' ')fail('JSON_CONTROL');}fail('JSON_STRING');};
 const value=depth=>{if(depth>64)fail('JSON_DEPTH');space();const c=text[at];if(c==='"'){string();return;}if(c==='{'){at++;space();const keys=new Set();if(text[at]==='}'){at++;return;}while(true){space();const key=string();if(keys.has(key))fail('JSON_DUPLICATE_KEY');keys.add(key);space();if(text[at++]!==':')fail('JSON_COLON');value(depth+1);space();if(text[at]==='}'){at++;return;}if(text[at++]!==',')fail('JSON_COMMA');}}if(c==='['){at++;space();if(text[at]===']'){at++;return;}while(true){value(depth+1);space();if(text[at]===']'){at++;return;}if(text[at++]!==',')fail('JSON_COMMA');}}const m=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));if(!m)fail('JSON_VALUE');at+=m[0].length;};
 value(0);space();if(at!==text.length)fail('JSON_TRAILING');return JSON.parse(text);
}
export function registryDigest(mode,value){const parsed=typeof value==='string'?parseUniqueJson(value):value;if(!validateRegistry(mode,parsed).ok)fail('REGISTRY_INVALID');return canonicalDigest(parsed);}
export function mergeExactProfiles(mode,current,upstream){
 const before=new Map(current.profiles.map(p=>[p.fingerprint,p])),next=new Map(),remap=new Map();
 for(const draft of upstream.profiles){
  let candidate=draft;
  const old=before.get(candidate.fingerprint);
  if(old){
   if(canonicalJson(old.operations)!==canonicalJson(candidate.operations))fail('FINGERPRINT_OPERATIONS_COLLISION');
   candidate=buildProfile(mode,{signalModel:candidate.signal.model,signalReasoning:candidate.signal.reasoning,request:candidate.request,builtIn:old.builtIn});
  }
  remap.set(draft.fingerprint,candidate.fingerprint);next.set(candidate.fingerprint,candidate);
 }
 // A complete current catalog replaces membership; signals come from current official label normalization.
 const profiles=[...next.values()];if(profiles.length>128)fail('PROFILE_LIMIT_EXCEEDED');const validation=validateSnapshot(mode,profiles);if(!validation.ok)fail(validation.reasons.join(','));
 let presentation=upstream.presentation;
 if(presentation){const rows=new Map();for(const original of presentation.profiles){const row={...structuredClone(original),fingerprint:remap.get(original.fingerprint)??original.fingerprint};if(rows.has(row.fingerprint)){const prior=rows.get(row.fingerprint);const origins=[...prior.origins,...row.origins];if(origins.length>128)fail('CATALOG_ORIGIN_LIMIT');if(prior.status!=='observed_selectable'&&row.status==='observed_selectable')rows.set(row.fingerprint,{...row,origins});else prior.origins=origins;}else rows.set(row.fingerprint,row);}presentation={...presentation,profiles:[...rows.values()]};}
 return {...upstream,profiles,presentation};
}
