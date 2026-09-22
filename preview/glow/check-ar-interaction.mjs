import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const pw=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const {chromium}=pw.default??pw;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const root=new URL('./captures/ar-v3-interaction/',import.meta.url);await mkdir(root,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1000,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:4177/preview/glow/target.html');
 const results=await page.evaluate(async()=>{
  const {ARBurstAdapter}=await import('/preview/glow/ARBurstAdapter.ts');
  const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;width:600px;height:600px;background:#b7bdc5;z-index:999';document.body.append(host);
  const a=new ARBurstAdapter(host);a.resize(600,600);
  while(!a.available)await new Promise(requestAnimationFrame);
  const results=[];let clock=0;
  for(let palette=0;palette<3;palette++)for(const collision of [false,true]){
   a.update(clock,null);a.burst(300,210,palette);
   let image;
   for(let frame=1;frame<=36;frame++){
    const age=frame/30;
    const head=collision?{cx:300+(frame>20?(frame-20)*2:0),cy:365,rx:100,ry:120}:null;
    a.update(clock+age,head,frame>20?60:0,0,1/30);
    if(frame===26)image=host.querySelector('canvas').toDataURL().split(',')[1];
    await new Promise(requestAnimationFrame);
   }
   const r=a.renderer,states=[...r.arStates.values()].flat();
   const stats=()=>states.map(s=>r.arSimulation.snapshot(s)).reduce((out,data)=>{
    for(let i=0;i<data.length;i+=12){if(data[i+6]>=0){out.bounced++;out.speed+=Math.hypot(data[i+2],data[i+3]);}if(!Number.isFinite(data[i]))out.invalid++;}return out;
   },{bounced:0,speed:0,invalid:0});
   const before=stats();
   a.update(clock+1.233,null,0,0,1/30);const after=stats();
   a.update(clock+3,null);
   const c=host.querySelector('canvas'),copy=document.createElement('canvas');copy.width=copy.height=600;
   const ctx=copy.getContext('2d');ctx.drawImage(c,0,0);
   const pixels=ctx.getImageData(0,0,600,600).data;let alpha=0;for(let i=3;i<pixels.length;i+=4)alpha+=pixels[i];
   results.push({palette,collision,before,after,alpha,image});clock+=4;
  }
  a.dispose();host.remove();return results;
 });
 for(const r of results){
  assert.equal(r.before.invalid,0);assert.equal(r.alpha,0);
  if(r.collision){assert.ok(r.before.bounced>100);assert.equal(r.after.bounced,r.before.bounced);assert.ok(r.after.speed>0);}
  else assert.equal(r.before.bounced,0);
  await writeFile(new URL(`palette-${r.palette}-${r.collision?'head':'free'}.png`,root),Buffer.from(r.image,'base64'));
 }
 assert.equal(new Set(results.filter(r=>!r.collision).map(r=>r.image)).size,3);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify(results.map(({image,...r})=>r)));
 await writeFile(new URL('results.json',root),JSON.stringify(results.map(({image,...r})=>r),null,2));
}finally{await browser.close();}
