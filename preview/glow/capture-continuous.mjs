import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const pw=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const {chromium}=pw.default??pw;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const root=new URL('./captures/continuous-v3/',import.meta.url);await mkdir(root,{recursive:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:4177/preview/glow/target.html');await page.waitForFunction(()=>window.targetStudy?.ready);
 const verification=await page.evaluate(()=>{
  const s=window.targetStudy,c=document.createElement('canvas');c.width=c.height=760;const x=c.getContext('2d');
  const pixels=()=>{x.drawImage(s.renderer.element,0,0);return x.getImageData(0,0,760,760).data;};
  const difference=(a,b)=>{let sum=0;for(let i=0;i<a.length;i+=4)for(let k=0;k<3;k++)sum+=Math.abs(a[i+k]-b[i+k]);return sum/(760*760*3);};
  let maxPrefixDifference=0;
  for(let n=0;n<=19;n++){const t=n/30;s.renderer.renderTargetFrame(t,true);const a=pixels();s.seek(t);maxPrefixDifference=Math.max(maxPrefixDifference,difference(a,pixels()));}
  s.renderer.renderTargetFrame(.85,true);const approved=pixels();s.seek(.85);const peakDifference=difference(approved,pixels());
  s.seek(.849);const before=pixels();s.seek(.85);const at=pixels();s.seek(.851);const after=pixels();
  const incomingDifference=difference(before,at),outgoingDifference=difference(at,after);
  s.seek(.85);const peak=pixels();s.seek(.851);const boundaryDifference=difference(peak,pixels());
  s.seek(2.6);const end=pixels();let residue=0;for(let i=0;i<end.length;i+=4)residue=Math.max(residue,end[i],end[i+1],end[i+2]);
  return {maxPrefixDifference,peakDifference,incomingDifference,outgoingDifference,boundaryDifference,residue};
 });
 assert.ok(verification.maxPrefixDifference<.02,JSON.stringify(verification));assert.ok(verification.peakDifference<.02);
 // Moving fine sparks can change many pixels; compare adjacent equal-time
 // differences instead of penalising the motion we explicitly want to retain.
 assert.ok(verification.outgoingDifference/verification.incomingDifference>0.8&&verification.outgoingDifference/verification.incomingDifference<1.25,JSON.stringify(verification));assert.equal(verification.residue,0);
 const times=[...Array.from({length:19},(_,i)=>.65+i/60),1.1,1.4,1.7,2.0,2.3,2.6];const frames=[];
 for(const t of times){const png=await page.evaluate(t=>{const s=window.targetStudy;s.seek(t);const c=document.createElement('canvas');c.width=c.height=760;c.getContext('2d').drawImage(s.renderer.element,0,0);return c.toDataURL().split(',')[1];},t);const name=`frame-${t.toFixed(3)}.png`;await writeFile(new URL(name,root),Buffer.from(png,'base64'));frames.push({t,name});}
 await writeFile(new URL('index.html',root),`<!doctype html><meta charset="utf-8"><title>连续运动 v1</title><style>body{background:#16191e;color:white;font:18px system-ui;padding:20px}section{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}img{width:100%}a{color:#9cdfff}</style><h1>23–35 帧连续过渡及后续消散</h1><p><a href="../../target.html">完整动态预览</a> · 点击截图查看原图</p><section>${frames.map(f=>`<div><p>${f.t.toFixed(3)} 秒 · 帧 ${(f.t*30).toFixed(0)}</p><a href="${f.name}"><img src="${f.name}"></a></div>`).join('')}</section>`);
 await writeFile(new URL('verification.json',root),JSON.stringify({verification,errors},null,2));assert.deepEqual(errors,[]);console.log(JSON.stringify(verification));
}finally{await browser.close();}
