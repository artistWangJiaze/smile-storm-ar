import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const pw=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const {chromium}=pw.default??pw;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const out=new URL('./captures/head-rebound-v3/',import.meta.url);await mkdir(out,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:600,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.route('**/__head_test',r=>r.fulfill({contentType:'text/html',body:'<body style="margin:0;background:#080d14"><div id="mount"></div></body>'}));
 await page.goto('http://127.0.0.1:4177/__head_test');
 const result=await page.evaluate(async()=>{
  const {ARBurstAdapter}=await import('/preview/glow/ARBurstAdapter.ts');
  const {pointInsideCollider}=await import('/src/HeadInteraction.ts');
  const a=new ARBurstAdapter(document.querySelector('#mount'));a.resize(600,900);
  while(!a.available)await new Promise(requestAnimationFrame);
  const head={cx:300,cy:670,rx:170,ry:240,points:Array.from({length:18},(_,i)=>({x:300+170*Math.cos(i*Math.PI/9),y:670+240*Math.sin(i*Math.PI/9)}))};
  a.burst(300,265,1);
  const r=a.renderer,canvas=document.createElement('canvas');canvas.width=600;canvas.height=900;
  const ctx=canvas.getContext('2d'),captures=[],previous=new Map();
  const metrics={bounced:0,penetrated:0,returned:0,separated:0,minOutward:Infinity,earlySeparation:0,earlySamples:0,glError:0};
  for(let f=0;f<=162;f++){
   const t=f/60;a.update(t,head,0,0,1/60);
   if(f%6===0&&t<2.5){
    let hits=0;
    for(const [layer,state] of [...r.arStates.values()].flat().entries()){
     const data=r.arSimulation.snapshot(state);
     for(let i=0;i<data.length;i+=12){
      const age=data[i+6];if(age<0)continue;hits++;
      const sep=(data[i]-data[i+10])*data[i+4]+(data[i+1]-data[i+11])*data[i+5];
      if(age<0.15)metrics.minOutward=Math.min(metrics.minOutward,data[i+2]*data[i+4]+data[i+3]*data[i+5]);
      if(age>.2&&sep>30)metrics.separated++;
      if(age>=.2&&age<=.3){metrics.earlySeparation+=sep;metrics.earlySamples++;}
      if(pointInsideCollider(data[i],data[i+1],head))metrics.penetrated++;
      const key=layer*90000+i/12;if(previous.has(key)&&sep<previous.get(key)-.05)metrics.returned++;previous.set(key,sep);
     }
    }metrics.bounced=Math.max(metrics.bounced,hits);
   }
   if([27,42,60,78].includes(f)){
    ctx.fillStyle='#080d14';ctx.fillRect(0,0,600,900);ctx.beginPath();head.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.fillStyle='#263540';ctx.fill();
    ctx.drawImage(r.canvas,0,0);ctx.fillStyle='white';ctx.font='20px sans-serif';ctx.fillText(`Stationary head / ${t.toFixed(2)}s`,20,30);
    captures.push({frame:f,png:canvas.toDataURL().split(',')[1]});
   }
   await new Promise(requestAnimationFrame);
  }
  metrics.earlySeparation/=Math.max(1,metrics.earlySamples);
  metrics.glError=r.gl.getError();a.dispose();return {metrics,captures};
 });
 for(const c of result.captures)await writeFile(new URL(`frame-${c.frame}.png`,out),Buffer.from(c.png,'base64'));
 await writeFile(new URL('results.json',out),JSON.stringify({metrics:result.metrics,errors},null,2));
 console.log(JSON.stringify({metrics:result.metrics,errors}));
 assert.equal(result.metrics.penetrated,0);assert.equal(result.metrics.returned,0);
 assert.ok(result.metrics.minOutward>50);assert.ok(result.metrics.separated>500);assert.equal(result.metrics.glError,0);assert.deepEqual(errors,[]);
 assert.ok(result.metrics.earlySeparation>45,'first impact should separate visibly within 0.2–0.3 seconds');
}finally{await browser.close();}
