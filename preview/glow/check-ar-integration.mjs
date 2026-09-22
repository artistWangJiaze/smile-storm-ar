import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const pw=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const {chromium}=pw.default??pw;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const root=new URL('./captures/ar-v3/',import.meta.url);await mkdir(root,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1100,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:4177/?fireworks=v3');
 await page.waitForFunction(()=>document.querySelector('.td-burst-canvas')?.width>1);
 await page.evaluate(async()=>{
  document.querySelector('#permission-screen').classList.add('is-hidden');
  // Synthetic bright video through the actual camera DOM layer; no webcam.
  const c=document.createElement('canvas');c.width=720;c.height=1280;const x=c.getContext('2d');
  x.fillStyle='#dce1e6';x.fillRect(0,0,720,1280);x.fillStyle='#a2b0bc';x.fillRect(0,180,310,600);x.fillStyle='#66788b';x.fillRect(380,0,80,1280);
  const v=document.querySelector('#camera');v.srcObject=c.captureStream(30);await v.play();
 });
 await page.keyboard.press('Alt+l');
 await page.waitForFunction(()=>Number(document.querySelector('#firework-count').textContent)>=270000,{},{timeout:15000});
 await page.screenshot({path:new URL('triggered.png',root).pathname});
 await page.keyboard.press('Alt+l');
 await page.waitForFunction(()=>Number(document.querySelector('#firework-count').textContent)>=540000,{},{timeout:15000});
 const peakCount=await page.locator('#firework-count').textContent();
 await page.screenshot({path:new URL('overlap.png',root).pathname});
 await page.waitForFunction(()=>Number(document.querySelector('#firework-count').textContent)===0,{},{timeout:20000});
 const adapterResult=await page.evaluate(async()=>{
  const {ARBurstAdapter}=await import('/preview/glow/ARBurstAdapter.ts');
  const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;width:760px;height:760px;background:#d7dde3;z-index:999';document.body.append(host);
  const a=new ARBurstAdapter(host);a.resize(760,760);await new Promise(resolve=>{const poll=()=>a.available?resolve():requestAnimationFrame(poll);poll();});
  const c=host.querySelector('canvas'),copy=document.createElement('canvas');copy.width=copy.height=760;const x=copy.getContext('2d');
  const snap=()=>{x.clearRect(0,0,760,760);x.drawImage(c,0,0);const p=x.getImageData(0,0,760,760).data;let alpha=0;for(let i=3;i<p.length;i+=4)alpha+=p[i];return {alpha,png:copy.toDataURL().split(',')[1]};};
  a.update(0,null);const empty=snap().alpha;a.burst(380,380,0);a.update(.85,null);const peak=snap();
  a.burst(280,320,0);a.update(1.3,null);const overlap=a.activeCount;
  const image=host.querySelector('canvas').toDataURL().split(',')[1];
  a.update(4,null);const final=snap().alpha;a.dispose();host.remove();return {empty,peakAlpha:peak.alpha,overlap,final,image};
 });
 assert.equal(adapterResult.empty,0);assert.equal(adapterResult.final,0);assert.ok(adapterResult.peakAlpha>0);assert.equal(adapterResult.overlap,540000);assert.deepEqual(errors,[]);
 await writeFile(new URL('transparent-overlap.png',root),Buffer.from(adapterResult.image,'base64'));
 console.log(JSON.stringify({errors,peakCount,...adapterResult,image:undefined}));
}finally{await browser.close();}
