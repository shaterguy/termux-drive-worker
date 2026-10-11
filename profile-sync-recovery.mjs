import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function processIdentity(pid = process.pid, io = fs) {
  try {
    if(!Number.isSafeInteger(pid)||pid<=0)return null;
    const base='/proc/'+pid,status=io.readFileSync(base+'/status','utf8');
    if(Number(status.match(/^Uid:\s+(\d+)/m)?.[1])!==process.getuid())return null;
    const raw=io.readFileSync(base+'/stat','utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
    return {pid,start_time:fields[19],boot_id:io.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),state:fields[0]};
  }catch{return null;}
}
export function processEnded(identity, io=fs) {
  if(!identity||!Number.isSafeInteger(identity.pid)||!identity.start_time||!identity.boot_id)return false;
  try {
    const boot=io.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    if(boot!==identity.boot_id)return true;
    const raw=io.readFileSync('/proc/'+identity.pid+'/stat','utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
    return fields[19]!==identity.start_time||['Z','X'].includes(fields[0]);
  }catch(error){return error?.code==='ENOENT';}
}
export function readPrivateJournal(file, io=fs) {
  try {
    const stat=io.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.size>16384)throw Error('invalid journal');
    return JSON.parse(io.readFileSync(file,'utf8'));
  }catch(error){if(error?.code==='ENOENT')return null;throw Error('PROFILE_SYNC_RECOVERY_JOURNAL_UNVERIFIED');}
}
export function writePrivateJournal(file,value,io=fs) {
  io.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.tmp-'+randomUUID();
  io.writeFileSync(temp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
  io.renameSync(temp,file);
}
export class FileCoordinationJournal {
  constructor(file){this.file=file;}
  read(){return readPrivateJournal(this.file);}
  write(value){writePrivateJournal(this.file,value);}
}
