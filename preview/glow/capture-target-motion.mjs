import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {imageDifference} from './compare-capture.mjs';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const {chromium}=playwright.default??playwright;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1000,height:1250},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});
const snap=()=>page.evaluate(()=>{
 const s=window.targetStudy;s.renderer.refreshBackground();
 const c=document.createElement('canvas');c.width=c.height=760;const x=c.getContext('2d');x.drawImage(s.renderer.element,0,0);
 const p=x.getImageData(0,0,760,760).data;let sum=0,max=0;
 for(let i=0;i<p.length;i+=4){sum+=p[i]+p[i+1]+p[i+2];max=Math.max(max,p[i],p[i+1],p[i+2]);}
 return {png:c.toDataURL().split(',')[1],mean:sum/(760*760*3),max};
});
try{
 await page.addInitScript(()=>{
  navigator.mediaDevices.getUserMedia=async()=>{
   const c=document.createElement('canvas');c.width=c.height=760;const x=c.getContext('2d');
   window.paintTestBackground=colour=>{x.fillStyle=colour;x.fillRect(0,0,760,760);};
   window.paintTestBackground('#8195ad');
   window.testPaintTimer=setInterval(()=>{x.fillRect(0,0,1,1);},30);
   return c.captureStream(30);
  };
 });
 await page.goto('http://localhost:4177/preview/glow/target.html');
 await page.waitForFunction(()=>window.targetStudy?.ready,{},{timeout:15000});
 const golden=(await readFile(new URL('./captures/target-new.png',import.meta.url))).toString('base64');
 const initial=await snap();
 const staticDifference=await imageDifference(page,initial.png,golden);
 assert.ok(staticDifference.mean<0.01&&staticDifference.changedRatio<0.005,JSON.stringify(staticDifference));
 const frames=[];
 for(const t of [0,0.3,0.85,1.4,2,2.6]){
  await page.evaluate(t=>window.targetStudy.seek(t),t);
  const frame=await snap();frames.push({t,mean:frame.mean,max:frame.max});
  if(t===0||t===2.6)assert.equal(frame.max,0,'No residual RGB at start/end');
  if(t===0.85){const d=await imageDifference(page,frame.png,golden);assert.ok(d.mean<0.01&&d.changedRatio<0.005,`Peak changed: ${JSON.stringify(d)}`);}
  await writeFile(new URL(`./captures/motion-${t.toFixed(2)}.png`,import.meta.url),Buffer.from(frame.png,'base64'));
 }
 // Real UI play/pause/seek, not only renderer calls.
 await page.getByRole('button',{name:'重新绽放',exact:true}).click();
 await page.waitForFunction(()=>window.targetStudy.time>0.2);
 await page.getByRole('button',{name:'暂停',exact:true}).click();
 const paused=await page.evaluate(()=>window.targetStudy.time);
 await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,160)));
 assert.equal(await page.evaluate(()=>window.targetStudy.time),paused);
 await page.locator('#timeline').evaluate(e=>{e.value='1.39';});
 await page.locator('#timeline').press('ArrowRight');
 assert.equal(await page.evaluate(()=>window.targetStudy.time),1.4);
 await page.getByRole('button',{name:'播放动态',exact:true}).click();
 await page.waitForFunction(()=>window.targetStudy.time===2.6&&!window.targetStudy.playing);
 assert.equal((await snap()).max,0);
 // Same live compositing route as the webcam, but no real camera permissions.
 await page.getByRole('button',{name:'开启摄像头背景',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('camera-button').getAttribute('aria-pressed')==='true');
 const empty=await snap();
 const cameraFrames=[];
 for(const t of [0,0.3,0.85,1.1,1.4,1.8,2.2,2.6]){
  await page.evaluate(t=>window.targetStudy.seek(t),t);
  cameraFrames.push({t,png:(await snap()).png});
 }
 const cameraPeak=cameraFrames.find(frame=>frame.t===0.85);assert.notEqual(cameraPeak.png,empty.png);
 await writeFile(new URL('./captures/motion-camera-peak.png',import.meta.url),Buffer.from(cameraPeak.png,'base64'));
 const contactSheet=await page.evaluate(async frames=>{
  const images=await Promise.all(frames.map(async frame=>{const image=new Image();image.src='data:image/png;base64,'+frame.png;await image.decode();return {...frame,image};}));
  const c=document.createElement('canvas');c.width=1200;c.height=680;const x=c.getContext('2d');
  x.fillStyle='#11151b';x.fillRect(0,0,c.width,c.height);x.font='22px system-ui';x.textAlign='left';
  images.forEach((frame,index)=>{const col=index%4,row=Math.floor(index/4),left=col*300,top=row*340;x.drawImage(frame.image,left,top,300,300);x.fillStyle='#f4f7fb';x.fillText(frame.t.toFixed(2)+' 秒',left+12,top+329);});
  return c.toDataURL().split(',')[1];
 },cameraFrames);
 await writeFile(new URL('./captures/complete-camera-storyboard.png',import.meta.url),Buffer.from(contactSheet,'base64'));
 await page.evaluate(async()=>{
  const s=window.targetStudy;s.seek(0);
  const canvasStream=s.renderer.element.captureStream(30),chunks=[];
  const recorder=new MediaRecorder(canvasStream,{mimeType:'video/webm'});
  window.cameraMotionRecording=new Promise(resolve=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onstop=async()=>{const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let str='';for(const b of bytes)str+=String.fromCharCode(b);canvasStream.getTracks().forEach(t=>t.stop());resolve(btoa(str));};});
  recorder.start();s.start();setTimeout(()=>recorder.stop(),3000);
 });
 const cameraWebm=await page.evaluate(()=>window.cameraMotionRecording);
 await writeFile(new URL('./captures/target-camera-motion.webm',import.meta.url),Buffer.from(cameraWebm,'base64'));
 await page.locator('#timeline').press('End');
 const final=await snap();assert.ok(Math.abs(final.mean-empty.mean)<1,'Camera restored on expiry');
 await page.evaluate(()=>window.paintTestBackground('#233446'));
 await page.waitForFunction(()=>document.getElementById('camera').currentTime>0.3);
 await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,120)));
 assert.ok((await snap()).mean<final.mean-30,'Background stays live while particles paused/expired');
 await page.getByRole('button',{name:'黑底／关闭摄像头',exact:true}).click();
 await page.evaluate(()=>clearInterval(window.testPaintTimer));
 // Record actual canvas animation for inspection; does not record webcam.
 await page.evaluate(async()=>{
  const s=window.targetStudy;s.seek(0);
  const stream=s.renderer.element.captureStream(30),chunks=[];
  const recorder=new MediaRecorder(stream,{mimeType:'video/webm'});
  window.motionRecording=new Promise(resolve=>{
   recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
   recorder.onstop=async()=>{const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let str='';for(const b of bytes)str+=String.fromCharCode(b);stream.getTracks().forEach(t=>t.stop());resolve(btoa(str));};
  });
  recorder.start();s.start();setTimeout(()=>recorder.stop(),3000);
 });
 const webm=await page.evaluate(()=>window.motionRecording);
 await writeFile(new URL('./captures/target-motion.webm',import.meta.url),Buffer.from(webm,'base64'));
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,staticDifference,frames,checks:'golden peak within subpixel tolerance, zero residual, playback/pause/scrub, live synthetic background/restoration, WebGL recording'},null,2));
}finally{await browser.close();}
