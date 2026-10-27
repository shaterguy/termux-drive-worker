import { fileURLToPath } from 'node:url';
import { runCollectorProcess } from './profile-chat-source.mjs';

export function validateLoopbackEndpoint(value) {
  try {const u=new URL(value);return u.protocol==='http:'&&u.hostname==='127.0.0.1'&&/^[0-9]+$/.test(u.port)&&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}
}
export async function collectIndependentCatalog({catalogKind,signal,deadline,ownershipJournal,reservationOwner,onCleanup}){
  let result;
  try {
    result=await runCollectorProcess(process.execPath,[fileURLToPath(new URL('./independent-catalog-collector.mjs',import.meta.url)),
      '--catalog-kind='+catalogKind,'--ownership-journal='+ownershipJournal,'--reservation-owner='+reservationOwner,'--lease-deadline-ms='+deadline],
      {timeout:90000,killSignal:'SIGTERM',maxBuffer:196608,signal,ownershipJournal,reservationOwner,env:{HOME:'/data/data/com.termux/files/home'}});
  }catch(e){onCleanup?.(e.cleanupVerified===true);throw Error('INDEPENDENT_COLLECTION_FAILED');}
  let c;try{c=JSON.parse(result.stdout)}catch{onCleanup?.(false);throw Error('INDEPENDENT_COLLECTION_INVALID');}
  onCleanup?.(c.own_tab_cleanup==='closed');
  if(c.own_tab_cleanup!=='closed'||!['ok','ok_partial'].includes(c.status))throw Error(c.error||'INDEPENDENT_COLLECTION_FAILED');
  return c;
}
export class IndependentCatalogSource {
  constructor({isActive=async()=>true,collect,parser,catalogKind='WORK',deadline,ownershipJournal,reservationOwner,canWrite}={}) {
    this.isActive=isActive;this.collect=collect||collectIndependentCatalog;this.parser=parser;this.catalogKind=catalogKind;
    this.deadline=deadline;this.ownershipJournal=ownershipJournal;this.reservationOwner=reservationOwner;
    this.canWrite=canWrite||(()=>this.isActive());this.cleanupVerified=true;this.catalogMetadata=null;
  }
  async fetch(){
    if(!await this.isActive())throw Error('ACTIVE_ROLE_LOST');
    this.cleanupVerified=false;let verified=false;let checking=false;const controller=new AbortController();
    const monitor=setInterval(()=>{if(checking)return;checking=true;void this.isActive().then(active=>{if(!active)controller.abort()}).catch(()=>controller.abort()).finally(()=>{checking=false})},250);
    try {
      const catalog=await this.collect({signal:controller.signal,catalogKind:this.catalogKind,deadline:this.deadline,ownershipJournal:this.ownershipJournal,reservationOwner:this.reservationOwner,onCleanup:value=>{verified=value===true;}});
      if(controller.signal.aborted||!await this.isActive())throw Error('ACTIVE_ROLE_LOST');
      const result=this.parser(catalog);this.catalogMetadata=result.catalog_metadata;return result;
    }finally{clearInterval(monitor);this.cleanupVerified=verified;}
  }
}
