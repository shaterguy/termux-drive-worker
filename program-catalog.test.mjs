import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_PROGRAMS, buildProgramInventory, parseHelp, renderProgramInventoryMarkdown } from './program-catalog.mjs';

test('major program descriptions and example commands are complete', () => {
  assert.ok(Object.keys(KNOWN_PROGRAMS).length >= 70);
  for (const [name, row] of Object.entries(KNOWN_PROGRAMS)) {
    assert.ok(name.length > 1);
    assert.ok(row.description.length >= 8, name);
    assert.ok(row.category.length >= 2, name);
    assert.ok(row.examples.every(s => s === name || s.startsWith(name+' ')), name);
  }
});

test('help parsing extracts actual advertised subcommands and flags', () => {
  const output = 'REA\nCommands:\n  inspect-artifact  Inspect file\n  decompile         Decompile one function\n\nGlobal Options:\n  --help  Usage\n  --format <json>\n';
  assert.deepEqual(parseHelp(output).subcommands,['inspect-artifact','decompile']);
  assert.ok(parseHelp(output).options.includes('--format'));
});

test('only installed programs are emitted; custom scripts are not run', async () => {
  const used=[];
  const result=await buildProgramInventory({
    git:'/opt/termux/bin/git',rea:'/opt/termux/bin/rea',
    'custom-job':'/data/home/bin/custom-job'
  },{home:'/data/home',prefix:'/opt/termux',cacheFile:false,probeHelp:async (file,name)=>{
    used.push(name);
    return {status:'help_confirmed',subcommands:[name==='rea'?'decompile':'status'],options:['--help']};
  }});
  assert.equal(result.detected_count,3);
  assert.equal(result.documented_count,2);
  assert.deepEqual(used,['git','rea']);
  const custom=result.records.find(x=>x.name==='custom-job');
  assert.equal(custom.description_source,'unknown');
  assert.equal(custom.help.status,'not_probed');
  assert.equal(custom.operation_tested,false);
  assert.ok(renderProgramInventoryMarkdown(result).includes('decompile')===false ||
    result.records.some(x=>x.name==='rea'&&x.help.subcommands.includes('decompile')));
});

test('absent major program is not advertised', async ()=>{
  const inv=await buildProgramInventory({}, {home:'/unused',prefix:'/unused',cacheFile:false});
  assert.equal(inv.detected_count,0);
  assert.equal(inv.documented_count,0);
  assert.equal(inv.help_confirmed_count,0);
});



test('automatic help inspection never exceeds two concurrent probes', async () => {
  let active=0;
  let maximum=0;
  const locations = Object.fromEntries(['git','gh','rea','curl','ffmpeg','npm'].map(x=>[x,'/sandbox/bin/'+x]));
  const inv=await buildProgramInventory(locations,{home:'/unused',prefix:'/sandbox',cacheFile:false,probeHelp:async ()=>{
    active+=1;
    maximum=Math.max(maximum,active);
    await new Promise(resolve=>setTimeout(resolve,8));
    active-=1;
    return {status:'help_confirmed',subcommands:[],options:[]};
  }});
  assert.equal(inv.detected_count,6);
  assert.ok(maximum <= 2);
  assert.ok(maximum >= 1);
});
