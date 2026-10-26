const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('browser schedule helper exists',()=>assert.ok(fs.existsSync(__dirname+'/studio-schedule-query.cjs')));
test('page preparation activates tab before actions',async()=>{
 const {preparePage}=require('./studio-schedule-query.cjs');const events=[];
 await preparePage({bringToFront:async()=>events.push('active'),setDefaultTimeout:n=>events.push(n),setDefaultNavigationTimeout:n=>events.push(n)});
 assert.deepEqual(events,['active',10000,25000]);
});
test('schedule parsing preserves actual GMT offset and noon',()=>{
 const {parseSchedule}=require('./studio-schedule-query.cjs');
 assert.equal(parseSchedule({date:'2026. 10. 26.',time:'오후 2:00',scheduler:'현지 시간대(GMT+0900)'}),'2026-10-26T14:00:00+09:00');
 assert.equal(parseSchedule({date:'2026. 10. 26.',time:'오전 12:00',scheduler:'GMT+0900'}),'2026-10-26T00:00:00+09:00');
 assert.throws(()=>parseSchedule({date:'2026. 10. 26.',time:'오후 2:00',scheduler:''}),/UNVERIFIED/);
});
test('range proves completeness or rejects missing pagination evidence',()=>{
 const {parseRange}=require('./studio-schedule-query.cjs');
 assert.deepEqual(parseRange('30\\n11개 중 1~11'),{total:11,first:1,last:11});
 assert.deepEqual(parseRange('동영상이 없습니다'),{total:0,first:0,last:0});
 assert.throws(()=>parseRange('loading'),/UNVERIFIED/);
});

test('idle tab selection skips a busy matching content tab',async()=>{
 const {selectIdlePage}=require('./studio-schedule-query.cjs');
 assert.equal(typeof selectIdlePage,'function');
 const busy={url:()=> 'https://studio.youtube.com/channel/UCtest/videos/upload',evaluate:async()=>false};
 const idle={url:()=> 'https://studio.youtube.com/channel/UCtest',evaluate:async()=>true};
 assert.equal(await selectIdlePage([busy,idle],'https://studio.youtube.com/channel/UCtest'),idle);
 await assert.rejects(selectIdlePage([busy],'https://studio.youtube.com/channel/UCtest'),/NO_IDLE/);
});
test('pagination ignores loading text until both range and video identities advance',async()=>{
 const {waitForNextRange}=require('./studio-schedule-query.cjs');
 assert.equal(typeof waitForNextRange,'function');
 const saved=global.document;let checked;
 try {
  const page={waitForFunction:async(fn,opts,arg)=>{
   global.document={body:{innerText:'loading changed 60개 중 1~30'},querySelectorAll:()=>[{getAttribute:()=>'/video/old/edit'}]};
   const loading=fn(arg);
   global.document={body:{innerText:'60개 중 31~60'},querySelectorAll:()=>[{getAttribute:()=>'/video/new/edit'}]};
   checked=[loading,fn(arg)];
  }};
  await waitForNextRange(page,30,['old']);assert.deepEqual(checked,[false,true]);
 }finally{global.document=saved}
});

test('zero-height dialog wrapper is an idle surface',async()=>{
 const {selectIdlePage}=require('./studio-schedule-query.cjs');
 const priorDoc=global.document,priorStyle=global.getComputedStyle;
 try {
  global.document={body:{innerText:''},querySelectorAll:()=>[{getClientRects:()=>[{width:1360,height:0}],getAttribute:()=>null}]};
  global.getComputedStyle=()=>({visibility:'visible'});
  const p={url:()=> 'https://studio.youtube.com/channel/UCtest',evaluate:async f=>f()};
  assert.equal(await selectIdlePage([p],'https://studio.youtube.com/channel/UCtest'),p);
 }finally{global.document=priorDoc;global.getComputedStyle=priorStyle}
});
test('nonzero visible dialog still protects in-progress work',async()=>{
 const {selectIdlePage}=require('./studio-schedule-query.cjs');
 const priorDoc=global.document,priorStyle=global.getComputedStyle;
 try {
  global.document={body:{innerText:''},querySelectorAll:()=>[{getClientRects:()=>[{width:800,height:600}],getAttribute:()=>null}]};
  global.getComputedStyle=()=>({visibility:'visible'});
  const p={url:()=> 'https://studio.youtube.com/channel/UCtest',evaluate:async f=>f()};
  await assert.rejects(selectIdlePage([p],'https://studio.youtube.com/channel/UCtest'),/NO_IDLE/);
 }finally{global.document=priorDoc;global.getComputedStyle=priorStyle}
});
