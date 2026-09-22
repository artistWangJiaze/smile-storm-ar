import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {imageDifference} from './compare-capture.mjs';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const {chromium}=playwright.default??playwright;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1000,height:1250},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(['warning','error'].includes(m.type()))errors.push(m.text());});
try{
 await page.addInitScript(()=>{
  // Exercise the actual UI/video upload, without opening the user's camera.
  navigator.mediaDevices.getUserMedia=async()=>{
   if(window.denyTestCamera)throw new DOMException('Denied','NotAllowedError');
   const c=document.createElement('canvas');c.width=480;c.height=360;const x=c.getContext('2d');
   const paint=()=>{x.fillStyle='#bbc5d3';x.fillRect(0,0,480,360);x.fillStyle='#3b4658';x.fillRect(0,0,240,180);x.fillStyle='#f1ede5';x.fillRect(240,180,240,180);};paint();
   const stream=c.captureStream(30);window.testCameraStream=stream;
   const interval=setInterval(paint,33);window.testPaintTimer=interval;return stream;
  };
 });
 await page.goto('http://localhost:4177/preview/glow/target.html');
 await page.waitForFunction(()=>window.targetStudy?.ready,{},{timeout:15000});
 const snapshot=async()=>page.evaluate(()=>{const s=window.targetStudy;s.renderer.refreshBackground();const c=document.createElement('canvas');c.width=760;c.height=760;c.getContext('2d').drawImage(s.renderer.element,0,0,760,760);return c.toDataURL().split(',')[1];});
 const black=await snapshot();
 const approved=(await readFile(new URL('./captures/target-new.png',import.meta.url))).toString('base64');
 const approvedDifference=await imageDifference(page,black,approved);
 assert.ok(approvedDifference.mean<0.01&&approvedDifference.changedRatio<0.005,JSON.stringify(approvedDifference));
 await page.getByRole('button',{name:'开启摄像头背景',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('camera-button').getAttribute('aria-pressed')==='true');
 const camera=await snapshot();assert.notEqual(camera,black);
 await writeFile(new URL('./captures/target-camera-test.png',import.meta.url),Buffer.from(camera,'base64'));
 await page.getByRole('button',{name:'上一版 · 1.35 秒'}).click();
 assert.equal(await page.locator('#camera-button').getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'新小样 · 密集短火花'}).click();
 const switched=await snapshot();
 const difference=await page.evaluate(async({a,b})=>{
  const images=await Promise.all([a,b].map(async data=>{const i=new Image();i.src='data:image/png;base64,'+data;await i.decode();const c=document.createElement('canvas');c.width=c.height=760;const x=c.getContext('2d');x.drawImage(i,0,0);return x.getImageData(0,0,760,760).data;}));
  let sum=0,max=0;for(let i=0;i<images[0].length;i++){const d=Math.abs(images[0][i]-images[1][i]);sum+=d;max=Math.max(max,d);}return {mean:sum/images[0].length,max};
 },{a:switched,b:camera});
 assert.ok(difference.mean<1.0,`Switch-back video difference: ${JSON.stringify(difference)}`);
 await page.screenshot({path:new URL('./captures/target-camera-page.png',import.meta.url).pathname,fullPage:true});
 await page.getByRole('button',{name:'黑底／关闭摄像头'}).click();
 assert.ok(await snapshot()===black,'Closing camera must restore black preview');
 assert.equal(await page.evaluate(()=>window.testCameraStream.getTracks().every(t=>t.readyState==='ended')),true);
 await page.evaluate(()=>{clearInterval(window.testPaintTimer);window.denyTestCamera=true;});
 await page.getByRole('button',{name:'开启摄像头背景',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('camera-status').textContent.includes('摄像头未开启'));
 assert.ok(await snapshot()===black,'Denial must preserve black preview');
 assert.deepEqual(errors,[]);
 console.log('PASS: approved black frame within subpixel tolerance; camera UI/composite/switching/track shutdown/denial tested using synthetic video; no real webcam accessed.');
}finally{await browser.close();}
