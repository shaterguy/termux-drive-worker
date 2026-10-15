import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeSchema, safeText, renderUsage, mergeManaged, schemaDigest} from './mcp-usage-docs.mjs';
test('schema retains required nested union and safe enums, drops secret-bearing samples',()=>{
 const x=sanitizeSchema({type:'object',required:['url'],properties:{url:{type:'string',default:'SECRET',examples:['SECRET'],description:'key=AIza12345678901234567890123456789012345'},mode:{enum:['auto','manual']},nested:{oneOf:[{type:'object',properties:{n:{type:'integer'}}},{type:'null'}]}}});
 assert.deepEqual(x.required,['url']);assert.deepEqual(x.properties.mode.enum,['auto','manual']);assert.equal(x.properties.nested.oneOf[0].properties.n.type,'integer');assert.ok(!JSON.stringify(x).includes('SECRET'));assert.ok(!JSON.stringify(x).includes('AIza'));
});
test('text strips authentication URLs, tokens, email samples and caps size',()=>{
 const x=safeText('https://example.com/oauth?token=abc Bearer secretvalue person@example.com '+ 'x'.repeat(5000));assert.ok(!x.includes('oauth'));assert.ok(!x.includes('secretvalue'));assert.ok(!x.includes('person@'));assert.ok(x.length<=1200);
});
test('managed block preserves notes and rejects ambiguous or edited auto content',()=>{
 const a=mergeManaged('', 'one'); const b=mergeManaged(a+'\nUSER NOTES keep\n','two');assert.match(b,/USER NOTES keep/);assert.match(b,/two/);assert.throws(()=>mergeManaged(a.replace('one','edited'),'two'),/CONFLICT/);assert.throws(()=>mergeManaged(a+a,'two'),/CONFLICT/);
});
test('schema digest is canonical and excludes sample defaults',()=>{assert.equal(schemaDigest({type:'string',default:'a'}),schemaDigest({default:'b',type:'string'}));});
test('render clearly identifies exact server route and inactive docs',()=>{
 const x=renderUsage({name:'youtube-transcript',version:'0.3.6-dev2'},[{name:'check_connection',inputSchema:{type:'object',properties:{}}}],{status:'fresh',sourceHash:'abc'});
 assert.match(x,/mcp-call youtube-transcript call check_connection/);assert.match(x,/YouTube_Transcript_MCP/);assert.match(x,/responseDirective/);assert.match(x,/권한/);
 const y=renderUsage({name:'removed'},[],{status:'inactive'});assert.match(y,/inactive/);
});
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publishUsage} from './mcp-usage-docs.mjs';
function fakeStore(){const files=new Map();let n=0;return {files,creates:0,async find(key){return [...files.values()].find(x=>x.key===key)},async reserve(){return 'id'+(++n)},async read(id){if(!files.has(id))throw Error('DRIVE_HTTP_404');return {...files.get(id)}},async update(c,text){if(files.get(c.id).text!==c.text)throw Error('DRIVE_HTTP_412');files.set(c.id,{...files.get(c.id),text});return this.read(c.id)},async create(id,name,key,text){this.creates++;files.set(id,{id,name,key,text});return this.read(id)}};}
test('create update remove and uncertain creation recover stable IDs without duplicate',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tdoc-test-'));const journalPath=path.join(dir,'journal.json');const store=fakeStore(),servers=[{name:'alpha',version:'1'}];let tools=[{name:'one',inputSchema:{type:'object'}}];const collect=async()=>tools;
 let r=await publishUsage({servers,store,journalPath,collect});const id=r[0].id;assert.equal(store.creates,1);assert.equal(r[0].status,'fresh');
 tools=[{name:'two',inputSchema:{type:'object'}}];r=await publishUsage({servers,store,journalPath,collect});assert.equal(r[0].id,id);assert.equal(store.creates,1);assert.match(store.files.get(id).text,/two/);
 await fs.unlink(journalPath);r=await publishUsage({servers,store,journalPath,collect});assert.equal(r[0].id,id);assert.equal(store.creates,1);
 r=await publishUsage({servers:[],store,journalPath,collect});assert.equal(r[0].status,'inactive');assert.equal(store.files.size,1);
 await fs.rm(dir,{recursive:true});
});
test('collection failure preserves successful doc and reports stale, failed creation publishes no link',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tdoc-test-'));const journalPath=path.join(dir,'j');const store=fakeStore(),servers=[{name:'alpha'}];let r=await publishUsage({servers,store,journalPath,collect:async()=>[]});const before=store.files.get(r[0].id).text;
 r=await publishUsage({servers,store,journalPath,collect:async()=>{throw Error('OFFLINE')}});assert.equal(r[0].status,'stale');assert.equal(store.files.get(r[0].id).text,before);
 store.create=async()=>{throw Error('FAILED')};r=await publishUsage({servers:[{name:'beta'}],store,journalPath,collect:async()=>[]});assert.equal(r[0].id,undefined);assert.equal(r[0].url,undefined);await fs.rm(dir,{recursive:true});
});
test('sensitive field contexts cannot publish short enum passwords',()=>{const s=sanitizeSchema({properties:{password:{type:'string',enum:['hunter2'],description:'hunter2'},nested:{properties:{api_key:{enum:['shortkey']}}}}});assert.ok(!JSON.stringify(s).includes('hunter2'));assert.ok(!JSON.stringify(s).includes('shortkey'));});
test('invalid render identities fail closed',()=>{assert.throws(()=>renderUsage({name:'bad; shell'},[],{}),/INVALID_TOOL/);});
test('uncertain accepted create is recovered without second create',async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tdoc-test-'));const journalPath=path.join(dir,'j'),store=fakeStore();const create=store.create.bind(store);store.create=async(...args)=>{await create(...args);throw Error('TIMEOUT')};const opts={servers:[{name:'alpha'}],store,journalPath,collect:async()=>[]};await publishUsage(opts);store.create=create;const r=await publishUsage(opts);assert.equal(r[0].status,'fresh');assert.equal(store.creates,1);await fs.rm(dir,{recursive:true});});
test('sensitive ancestry crosses unions and array items; safe unicode enum retained',()=>{const s=sanitizeSchema({properties:{password:{anyOf:[{enum:['shortsecret']}]},token:{type:'array',items:{enum:['shortsecret']}},mode:{enum:['한국어','English']}}});assert.ok(!JSON.stringify(s).includes('shortsecret'));assert.deepEqual(s.properties.mode.enum,['한국어','English']);});
import {collectTools} from './mcp-usage-docs.mjs';
import {createHash} from 'node:crypto';
test('cache requires matching current registry revision and freshness',async()=>{const home=await fs.mkdtemp(path.join(os.tmpdir(),'tdoc-cache-'));const data=path.join(home,'.drive-worker');await fs.mkdir(data);const cfg={root:'/r',source_commit:'abc',url:'http://localhost',version:'1'};await fs.writeFile(path.join(data,'mcp-servers.json'),JSON.stringify({alpha:cfg}));const fingerprint=createHash('sha256').update(JSON.stringify(cfg)).digest('hex');const cache={servers:{alpha:{status:'ok',collected_at:new Date().toISOString(),source_commit:'abc',registry_fingerprint:fingerprint,tools:[]}}};await fs.writeFile(path.join(data,'mcp-tools-cache.json'),JSON.stringify(cache));assert.deepEqual(await collectTools({name:'alpha',source_commit:'abc'},home),[]);await assert.rejects(collectTools({name:'alpha',source_commit:'new'},home),/REVISION_MISMATCH/);cache.servers.alpha.collected_at='2020-01-01';await fs.writeFile(path.join(data,'mcp-tools-cache.json'),JSON.stringify(cache));await assert.rejects(collectTools({name:'alpha',source_commit:'abc'},home),/STALE/);await fs.rm(home,{recursive:true});});
import {UsageDriveStore} from './mcp-usage-docs.mjs';
test('shared manifest reservation reuses ID and CAS conflict never creates a document',async()=>{const store=new UsageDriveStore({},'folder',async()=>true);let manifest={},etag=1,allocations=0;store.read=async()=>({id:'manifest',text:JSON.stringify(manifest),etag});store.request=async()=>({json:async()=>({ids:['reserved-id-'+(++allocations)]})});store.update=async(c,text)=>{if(c.etag!==etag)throw Error('DRIVE_HTTP_412');manifest=JSON.parse(text);etag++;};assert.equal(await store.reserve('key','alpha'),'reserved-id-1');assert.equal(await store.reserve('key','alpha'),'reserved-id-1');assert.equal(allocations,1);store.update=async()=>{throw Error('DRIVE_HTTP_412')};await assert.rejects(store.reserve('other','beta'),/412/);assert.equal(manifest.usage_doc_reservations.other,undefined);});

import {renderIndex} from './mcp-usage-docs.mjs';
test('manual routing describes designated procedure without assigning mover',()=>{const s=renderIndex([],[],'now');assert.ok(s.includes('지정된 MANUAL 절차로 처리된 동일 job_id'));assert.ok(!s.includes('worker가 옮겨'));assert.ok(s.includes('target_server를 생략하거나 AUTO'));});

test('index prefers DriveWorker MCP while retaining manual execution limits',()=>{
 const s=renderIndex([],[],'now');
 for(const name of ['publish_manual_command','submit_direct_command','get_job_status','get_job_result'])assert.ok(s.includes(name),name);
 assert.ok(s.includes('연결된 DriveWorker MCP를 우선'));
 assert.ok(s.includes('job_id에 MANUAL을 포함'));
 assert.ok(s.includes('수동 지정 작업을 Commands 폴더에 직접 게시하지 않습니다.'));
 assert.ok(s.includes('직접 실행이 승인되고 사용자 지정 수동 방식과 충돌하지 않을 때만'));
 assert.ok(s.includes('같은 작업에 두 제출 도구를 연속 호출하지 않습니다.'));
 assert.ok(s.includes('DriveWorker MCP를 사용할 수 없을 때만 Google Drive 도구'));
 assert.ok(s.includes('접근 거절을 우회하지'));
});
test('index distinguishes publication from final results and paginates original job logs',()=>{
 const s=renderIndex([],[],'now');
 assert.ok(s.includes('동일 job_id의 결과는 get_job_status와 get_job_result'));
 assert.ok(s.includes('최종 상태·exit_code'));
 assert.ok(s.includes('limit/cursor'));
 assert.ok(s.includes('PUBLISHED/AWAITING_MANUAL 및 SUBMITTED 응답은 실행 완료가 아닙니다.'));
 assert.ok(s.includes('결과 지연만으로 새 job을 중복 제출하거나 수동·직접 경로를 바꾸지 않습니다.'));
});
test('MCP guidance preserves per-server links automatic refresh and unmanaged notes',()=>{
 const docs=[{name:'alpha',status:'fresh',url:'https://drive.google.com/file/d/test/view',source_hash:'abc'}];
 const rendered=renderIndex([],docs,'2026-10-15T07:00:00Z');
 assert.ok(rendered.includes('[사용법](https://drive.google.com/file/d/test/view)'));
 assert.ok(rendered.includes('기존 DriveWorker capabilities/inventory 주기'));
 assert.ok(rendered.includes('target_server를 생략하거나 AUTO'));
 assert.ok(rendered.includes('MANUAL-REPLACE_UNIQUE_JOB_ID'));
 assert.ok(rendered.includes('명령 자체 제한'));
 const updated=mergeManaged(mergeManaged('','old')+'\nUSER NOTES keep\n',rendered);
 assert.ok(updated.includes('USER NOTES keep'));
 assert.ok(updated.includes('publish_manual_command'));
});
