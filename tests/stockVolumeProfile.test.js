import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateStockProfile,latestMarketDate,profileWindows,createProfileAccumulator,demoStockProfile} from '../shared/stockVolumeProfile.js';
import {createStockVolumeService,normalizeStockBars} from '../server/builder/stockVolume.js';
import {createStockVolumeStore} from '../server/builder/stockVolumeStore.js';
const now=Date.parse('2026-10-10T17:00:00Z');
const buckets=[{lowStrike:100,highStrike:100},{lowStrike:110,highStrike:110},{lowStrike:120,highStrike:120}];
test('stock settings support requested resolutions, bound workload and anchor ranges to New York sessions',()=>{
 assert.equal(latestMarketDate(now),'2026-10-09');assert.equal(latestMarketDate(Date.parse('2026-10-12T12:00:00Z')),'2026-10-09');assert.equal(latestMarketDate(Date.parse('2026-10-12T14:00:00Z')),'2026-10-12');
 for(const interval of ['1min','15min','30min','60min','4hour','day'])assert.equal(validateStockProfile({symbol:'AAPL',interval,days:365,buckets},now).interval,interval);
 assert.throws(()=>validateStockProfile({symbol:'AAPL',days:366,buckets},now));assert.throws(()=>validateStockProfile({symbol:'AAPL',interval:'5min',buckets},now));assert.throws(()=>validateStockProfile({symbol:'AAPL',buckets:[buckets[1],buckets[0]]},now));
 const settings=validateStockProfile({symbol:'AAPL',days:365,buckets},now);assert.ok(profileWindows(settings).length<=13);const minute=profileWindows({...settings,interval:'1min'});assert.ok(minute.length>250);assert.ok(minute.every(w=>w.from===w.to));
});
test('share aggregation uses close-price bins, handles midpoint ties and conserves outside-range volume',()=>{
 const p=createProfileAccumulator(buckets.map((b,i)=>({...b,key:String(i)})));
 for(const [close,volume]of [[100,10],[105,20],[115,30],[125,40],[126,50],[94,60]])p.add({close,volume,time:1});p.add({close:110,volume:null});
 const result=p.result();assert.deepEqual(result.bins.map(b=>b.volume),[10,20,70]);assert.equal(result.totalShares,210);assert.equal(result.displayedShares,100);assert.equal(result.outsideShares,110);assert.equal(result.missingBars,1);
});
test('sample resolutions conserve daily share volume including short final session bars',()=>{
 const bars=[{date:'2026-10-09',close:110,volume:1000001}];
 for(const interval of ['1min','15min','30min','60min','4hour','day']){const result=demoStockProfile(bars,validateStockProfile({symbol:'AAPL',days:1,interval,buckets},now));assert.equal(result.totalShares,1000001);assert.equal(result.barCount,Math.ceil(390/({day:390,'4hour':240,'60min':60,'30min':30,'15min':15,'1min':1}[interval])));}
});
test('provider bars are deduplicated by timestamp; absent volume and truncated windows are not silently accepted',()=>{
 const w={from:'2026-10-09',to:'2026-10-09'},bar={time:Date.parse('2026-10-09T14:30Z'),close:110,volume:50};assert.equal(normalizeStockBars([bar,bar],w).length,1);assert.throws(()=>normalizeStockBars([{...bar,volume:null}],w));assert.throws(()=>normalizeStockBars(Array(1200).fill(bar),w));
});
async function finished(service,id){for(let i=0;i<500;i++){const j=service.get('a',id);if(['completed','failed','cancelled'].includes(j.status))return j;await new Promise(r=>setTimeout(r,10));}throw new Error('Worker timed out');}
test('history jobs persist reusable bars, isolate job owners and re-bin locally without downloading again',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stock-volume-')),filename=path.join(dir,'bars.db');let requests=0;
 const provider=async(_p,q)=>{requests++;return {data:[...new Set([q.from,q.to])].map(date=>({time:Date.parse(date+'T15:00Z'),close:110,volume:50}))};};
 let service=createStockVolumeService({store:createStockVolumeStore(filename),enabled:()=>true,read:provider,now:()=>now});
 try{const j=service.start('a',{symbol:'AAPL',interval:'60min',days:30,buckets});assert.equal(service.get('b',j.id),null);assert.equal(service.cancel('b',j.id),null);const a=await finished(service,j.id);assert.equal(a.status,'completed');assert.equal(a.result.totalShares,200);assert.equal(requests,2);service.close();
 service=createStockVolumeService({store:createStockVolumeStore(filename),enabled:()=>true,read:provider,now:()=>now});const again=await finished(service,service.start('a',{symbol:'AAPL',interval:'60min',days:30,buckets:[{lowStrike:110,highStrike:110}]}).id);assert.equal(again.status,'completed');assert.equal(again.result.cacheHits,2);assert.equal(requests,2);assert.equal(again.result.totalShares,200);
 }finally{service.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('cancellation during provider collection prevents further windows and processing',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stock-volume-cancel-'));let release,calls=0;const gate=new Promise(r=>release=r);
 const service=createStockVolumeService({store:createStockVolumeStore(path.join(dir,'bars.db')),enabled:()=>true,read:async()=>{calls++;await gate;return {data:[]};},now:()=>now});
 try{const j=service.start('a',{symbol:'AAPL',interval:'1min',days:365,buckets});service.cancel('a',j.id);release();await new Promise(r=>setTimeout(r,20));assert.equal(service.get('a',j.id).status,'cancelled');assert.equal(calls,1);}finally{release();service.close();fs.rmSync(dir,{recursive:true,force:true});}
});
