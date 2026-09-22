import { mkdir,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = new URL('./captures/',import.meta.url);
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1100,height:1000},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='warning'||m.type()==='error')errors.push(m.text());});
try{
  await page.goto('http://localhost:4177/preview/glow/');
  await page.waitForFunction(()=>window.glowPreview?.ready,{},{timeout:15000});
  const captures=await page.evaluate(()=>{
    const p=window.glowPreview;p.pause();
    const canvas=document.createElement('canvas');canvas.width=760;canvas.height=760;const ctx=canvas.getContext('2d');
    const captures=[];
    for(const palette of [0,1]){
      p.setPalette(palette);
      for(const time of [0.55,0.8,1.2,1.8,2.6,3.6]){
        p.seek(time);
        for(const bg of ['black','light']){
          p.background(bg);
          ctx.fillStyle=bg==='black'?'#000':'#b6b9bf';ctx.fillRect(0,0,760,760);ctx.drawImage(p.renderer.element,0,0,760,760);
          captures.push({name:`palette-${palette}-${time}-${bg}.png`,image:canvas.toDataURL('image/png').split(',')[1]});
        }
      }
    }
    const gl=p.renderer.element.getContext('webgl2'),pixels=new Uint8Array(760*760*4);
    p.background('black');p.seek(3.6);
    gl.readPixels(0,0,760,760,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    return {captures,glError:gl.getError(),hdr:p.renderer.hdrEnabled,residue:pixels.some((x,i)=>i%4!==3&&x!==0)};
  });
  for(const c of captures.captures)await writeFile(new URL(c.name,output),Buffer.from(c.image,'base64'));
  assert.equal(captures.glError,0);assert.equal(captures.hdr,true);assert.equal(captures.residue,false);
  // Exercise the real video upload path with a local synthetic stream. This
  // requires no camera permission or recording of the user's surroundings.
  const cameraCheck=await page.evaluate(async()=>{
    const p=window.glowPreview;
    p.composite('current');
    const source=document.createElement('canvas');source.width=480;source.height=360;
    const ctx=source.getContext('2d');
    ctx.fillStyle='#b8c8d8';ctx.fillRect(0,0,480,360);
    ctx.fillStyle='#304050';ctx.fillRect(0,0,240,180);
    ctx.fillStyle='#f0e0d0';ctx.fillRect(240,180,240,180);
    const stream=source.captureStream(30),video=document.createElement('video');
    video.muted=true;video.playsInline=true;video.srcObject=stream;
    const play=video.play();ctx.drawImage(source,0,0);stream.getVideoTracks()[0].requestFrame();
    await Promise.race([play,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Test video failed to start')),5000))]);
    p.renderer.setBackground('camera',video);p.seek(3.6);
    const gl=p.renderer.element.getContext('webgl2');
    const read=()=>{p.renderer.refreshBackground();const pixels=new Uint8Array(760*760*4);gl.readPixels(0,0,760,760,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;};
    const baseline=read();
    const sample=(x,y)=>Array.from(baseline.slice(((759-y)*760+x)*4,((759-y)*760+x)*4+3));
    const expected=[[184,200,216],[48,64,80],[240,224,208],[184,200,216]];
    const actual=[sample(100,100),sample(660,100),sample(100,660),sample(660,660)];
    const cameraUnchanged=actual.every((rgb,i)=>rgb.every((v,k)=>Math.abs(v-expected[i][k])<=3));
    p.seek(1.2);const peak=read();let darkened=0,gain=0,changed=0;
    for(let i=0;i<peak.length;i++){if(i%4===3)continue;const d=peak[i]-baseline[i];if(d < -2)darkened++;gain+=d;if(d>10)changed++;}
    const c=document.createElement('canvas');c.width=760;c.height=760;c.getContext('2d').drawImage(p.renderer.element,0,0);
    const image=c.toDataURL('image/png').split(',')[1];
    const fixedTime=p.time;p.composite('colour-glow');const candidate=read();
    c.getContext('2d').drawImage(p.renderer.element,0,0);
    const candidateImage=c.toDataURL('image/png').split(',')[1];
    let currentChroma=0,candidateChroma=0;
    for(let i=0;i<candidate.length;i+=4){
      currentChroma+=Math.max(peak[i],peak[i+1],peak[i+2])-Math.min(peak[i],peak[i+1],peak[i+2]);
      candidateChroma+=Math.max(candidate[i],candidate[i+1],candidate[i+2])-Math.min(candidate[i],candidate[i+1],candidate[i+2]);
    }
    const frozenTime=p.time===fixedTime;
    p.seek(3.6);const expired=read();const clean=expired.every((v,i)=>v===baseline[i]);
    stream.getTracks().forEach(t=>t.stop());video.srcObject=null;p.renderer.setBackground('black');
    return {cameraUnchanged,actual,darkened,meanChannelGain:gain/(760*760*3),changed,clean,image,candidateImage,frozenTime,chromaRatio:candidateChroma/currentChroma};
  });
  await writeFile(new URL('video-composite-check.png',output),Buffer.from(cameraCheck.image,'base64'));
  await writeFile(new URL('video-composite-candidate.png',output),Buffer.from(cameraCheck.candidateImage,'base64'));
  delete cameraCheck.image;
  delete cameraCheck.candidateImage;
  assert.equal(cameraCheck.cameraUnchanged,true);assert.equal(cameraCheck.darkened,0);
  assert.ok(cameraCheck.meanChannelGain>10);assert.equal(cameraCheck.clean,true);
  assert.equal(cameraCheck.frozenTime,true);assert.ok(cameraCheck.chromaRatio>1.2);
  await page.evaluate(()=>{window.glowPreview.setPalette(0);window.glowPreview.seek(1.2);});
  await page.screenshot({path:new URL('preview-page.png',output).pathname,fullPage:true});
  if(process.env.RECORD==='1'){
    const video=await page.evaluate(async()=>{
      const p=window.glowPreview;p.pause();p.setPalette(0);p.seek(0);
      const c=document.createElement('canvas');c.width=760;c.height=760;const ctx=c.getContext('2d');
      const stream=c.captureStream(30),chunks=[],recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:6000000});
      recorder.ondataavailable=e=>chunks.push(e.data);recorder.start();
      for(let frame=0;frame<=216;frame++){
        p.step(1/60);ctx.fillStyle='#000';ctx.fillRect(0,0,760,760);ctx.drawImage(p.renderer.element,0,0,760,760);
        await new Promise(requestAnimationFrame);
      }
      const stop=new Promise(r=>recorder.onstop=r);recorder.stop();await stop;stream.getTracks().forEach(t=>t.stop());
      return await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(new Blob(chunks,{type:'video/webm'}));});
    });
    await writeFile(new URL('glow-preview.webm',output),Buffer.from(video,'base64'));
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',hdr:captures.hdr,residualPixels:captures.residue,cameraCheck,errors,output:output.pathname}));
}finally{await browser.close();}
