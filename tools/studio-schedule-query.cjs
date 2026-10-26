#!/usr/bin/env node
'use strict';
const {performance}=require('node:perf_hooks');
const ORIGIN='https://studio.youtube.com';
async function preparePage(page) {
  await page.bringToFront();
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(25000);
}
function parseRange(text) {
  const m=text.match(/(\d+)\s*개 중\s*(\d+)\s*[~∼–-]\s*(\d+)/);
  if(m)return {total:+m[1],first:+m[2],last:+m[3]};
  if(/동영상이 없습니다|표시할 동영상이 없습니다|No videos/.test(text))return {total:0,first:0,last:0};
  throw Error('LIST_RANGE_UNVERIFIED');
}
function parseSchedule({date,time,scheduler}) {
  const d=date.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  const t=time.match(/(\d{1,2}):(\d{2})/);
  const z=scheduler.match(/GMT\s*([+-])(\d{2}):?(\d{2})/);
  if(!d||!t||!z)throw Error('SCHEDULE_FIELDS_UNVERIFIED');
  let hour=+t[1];
  if(/오후|PM/i.test(time)&&hour<12)hour+=12;
  if(/오전|AM/i.test(time)&&hour===12)hour=0;
  if(hour>23||+t[2]>59)throw Error('INVALID_SCHEDULE_TIME');
  const pad=x=>String(x).padStart(2,'0');
  return d[1]+'-'+pad(d[2])+'-'+pad(d[3])+'T'+pad(hour)+':'+t[2]+':00'+z[1]+z[2]+':'+z[3];
}

async function selectIdlePage(pages,prefix) {
  const candidates=pages.filter(p=>p.url().startsWith(prefix+'/videos/')||p.url()===prefix||p.url()===prefix+'/content');
  for(const page of candidates) {
    const idle=await page.evaluate(()=>{
      const dialogs=[...document.querySelectorAll('[role="dialog"],tp-yt-paper-dialog,ytcp-dialog,ytcp-uploads-dialog')];
      const busy=dialogs.some(x=>[...x.getClientRects()].some(r=>r.width>0&&r.height>0)&&getComputedStyle(x).visibility!=='hidden'&&x.getAttribute('aria-hidden')!=='true');
      return !busy&&!/업로드 중|업로드하는 중/.test(document.body.innerText);
    });
    if(idle)return page;
  }
  throw Error('NO_IDLE_CHANNEL_TAB');
}
async function waitForNextRange(page,last,previousIds) {
  await page.waitForFunction(({last,previousIds})=>{
    const m=document.body.innerText.match(/(\d+)\s*개 중\s*(\d+)\s*[~∼–-]\s*(\d+)/);
    if(!m||+m[2]!==last+1||+m[3]<=last)return false;
    const ids=[...document.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).filter(x=>/^\/video\/[^/]+\/edit$/.test(x)).map(x=>x.split('/')[2]);
    return ids.some(id=>!previousIds.includes(id));
  },{timeout:15000},{last,previousIds});
}

async function querySchedules({channel,browserURL='http://127.0.0.1:9228'}) {
  if(!/^UC[A-Za-z0-9_-]{22}$/.test(channel))throw Error('INVALID_CHANNEL_ID');
  const puppeteer=require('puppeteer-core');
  const startedAt=new Date().toISOString(),t0=performance.now(),phases=[];
  const mark=phase=>phases.push({phase,elapsed_ms:Math.round(performance.now()-t0)});
  let browser,page,originalUrl,result,mainError;
  try {
    browser=await puppeteer.connect({browserURL,defaultViewport:null,protocolTimeout:15000});
    mark('connected');
    const pages=await browser.pages(),prefix=ORIGIN+'/channel/'+channel;
    page=await selectIdlePage(pages,prefix);
    if(!page)throw Error('NO_IDLE_CHANNEL_TAB');
    originalUrl=page.url();
    await preparePage(page);
    const scheduled=[],counts={};
    for(const [kind,route] of [['long','upload'],['short','short']]) {
      await page.goto(prefix+'/videos/'+route+'?filter=%5B%5D&sort=%7B%22columnType%22%3A%22date%22%2C%22sortOrder%22%3A%22DESCENDING%22%7D',{waitUntil:'domcontentloaded'});
      let seen=0,previous='';
      for(let pageNo=0;pageNo<100;pageNo++) {
        await page.waitForFunction(()=>/\d+\s*개 중\s*\d+\s*[~∼–-]\s*\d+/.test(document.body.innerText)||/동영상이 없습니다|표시할 동영상이 없습니다|No videos/.test(document.body.innerText),{timeout:15000});
        const data=await page.evaluate(()=>{
          const anchors=[...document.querySelectorAll('a[href]')].filter(a=>/^\/video\/[^/]+\/edit$/.test(a.getAttribute('href')));
          const byId=new Map();
          for(const a of anchors) {
            const id=a.getAttribute('href').split('/')[2];
            let e=a,row=null;
            while(e&&e!==document.body) {
              const ids=new Set([...e.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).filter(x=>/^\/video\/[^/]+\/edit$/.test(x)).map(x=>x.split('/')[2]));
              if(ids.size===1&&/예약됨/.test(e.innerText)){row=e;break;}
              e=e.parentElement;
            }
            if(!row)continue;
            const title=anchors.filter(a=>a.getAttribute('href')==='/video/'+id+'/edit').map(a=>a.innerText.trim()).sort((a,b)=>b.length-a.length)[0];
            byId.set(id,{video_id:id,title});
          }
          return {text:document.body.innerText,video_ids:[...new Set(anchors.map(a=>a.getAttribute('href').split('/')[2]))],scheduled:[...byId.values()]};
        });
        const range=parseRange(data.text);
        if(range.first<=seen&&range.total>0)throw Error('PAGINATION_DID_NOT_ADVANCE');
        scheduled.push(...data.scheduled.map(x=>({...x,kind})));
        seen=range.last;
        if(range.last>=range.total){counts[kind]=range.total;break;}
        previous=data.text;
        const clicked=await page.evaluate(()=>{
          const candidates=[...document.querySelectorAll('button,[role="button"]')];
          const x=candidates.find(x=>/다음 페이지|Next page/i.test(x.getAttribute('aria-label')||''));
          if(!x||x.disabled||x.getAttribute('aria-disabled')==='true')return false;
          x.click();return true;
        });
        if(!clicked)throw Error('NEXT_PAGE_UNAVAILABLE');
        await waitForNextRange(page,range.last,data.video_ids);
      }
      if(counts[kind]===undefined)throw Error('PAGINATION_LIMIT_EXCEEDED');
      mark(kind+'_list');
    }
    const unique=[...new Map(scheduled.map(x=>[x.video_id,x])).values()];
    for(const item of unique) {
      await page.goto(ORIGIN+'/video/'+item.video_id+'/edit',{waitUntil:'domcontentloaded'});
      await preparePage(page);
      await page.waitForSelector('[aria-label="동영상 공개 상태 수정"]');
      await page.evaluate(()=>document.querySelector('[aria-label="동영상 공개 상태 수정"]').click());
      await page.waitForSelector('ytcp-visibility-scheduler');
      const fields=await page.evaluate(()=>({
        date:document.querySelector('#datepicker-trigger')?.textContent.trim()||'',
        time:document.querySelector('ytcp-visibility-scheduler input')?.value||'',
        scheduler:document.querySelector('ytcp-visibility-scheduler')?.textContent.replace(/\s+/g,' ').trim()||''
      }));
      item.publish_at=parseSchedule(fields);
      item.status='SCHEDULED';
      await page.evaluate(()=>document.querySelector('ytcp-video-visibility-edit-popup #cancel-button')?.click());
      mark('schedule_'+item.video_id);
    }
    result={schema:'studio-schedule-query-v1',channel,started_at:startedAt,checked_at:new Date().toISOString(),counts,scheduled:unique,phases};
  } catch(error){mainError=error}
  finally {
    if(page&&originalUrl&&page.url()!==originalUrl) {
      try{await page.goto(originalUrl,{waitUntil:'domcontentloaded',timeout:25000})}
      catch(error){if(!mainError)mainError=Error('RESTORE_FAILED: '+error.message)}
    }
    if(browser)await browser.disconnect();
  }
  if(mainError)throw mainError;
  result.elapsed_ms=Math.round(performance.now()-t0);
  return result;
}
module.exports={preparePage,parseRange,parseSchedule,querySchedules,selectIdlePage,waitForNextRange};
if(require.main===module) {
  const args=process.argv.slice(2),pos=args.indexOf('--channel');
  querySchedules({channel:pos>=0?args[pos+1]:''}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1});
}
