import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const pw=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const {chromium}=pw.default??pw;
const root=new URL('./captures/frame-audit-20260922/',import.meta.url);
await mkdir(root,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const errors=[];
try{
 const page=await browser.newPage({viewport:{width:1000,height:1250},deviceScaleFactor:1});
 page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:4177/preview/glow/target.html?audit=20260922');
 await page.waitForFunction(()=>window.targetStudy?.ready);
 const sources={};
 for(const file of ['TargetFrame.ts','FourthFrame.ts','StoryboardFrame.ts','GlowPreviewRenderer.ts','target.ts']){
  const bytes=await readFile(new URL('./'+file,import.meta.url));
  sources[file]=createHash('sha256').update(bytes).digest('hex');
 }
 const frames=[];
 for(const mode of ['black','light']){
  await page.evaluate(mode=>window.targetStudy.renderer.setBackground(mode),mode);
  for(let n=0;n<=78;n++){
   const t=n/30;
   const frame=await page.evaluate(t=>{
    const s=window.targetStudy;s.seek(t);s.renderer.refreshBackground();
    const c=document.createElement('canvas');c.width=c.height=760;
    const x=c.getContext('2d');x.drawImage(s.renderer.element,0,0,760,760);
    const p=x.getImageData(0,0,760,760).data;let sum=0;
    for(let i=0;i<p.length;i+=4)sum+=p[i]+p[i+1]+p[i+2];
    return {png:c.toDataURL().split(',')[1],mean:sum/(760*760*3)};
   },t);
   const name=`${mode}-${String(n).padStart(3,'0')}.png`;
   await writeFile(new URL(name,root),Buffer.from(frame.png,'base64'));
   frames.push({mode,n,t,name,mean:frame.mean});
  }
 }
 const boundary=[];
 await page.evaluate(()=>window.targetStudy.renderer.setBackground('black'));
 for(const t of [.849,.85,.851,.86,.90,1.1]){
  const png=await page.evaluate(t=>{const s=window.targetStudy;s.seek(t);const c=document.createElement('canvas');c.width=c.height=760;c.getContext('2d').drawImage(s.renderer.element,0,0);return c.toDataURL().split(',')[1];},t);
  const name=`boundary-${t}.png`;await writeFile(new URL(name,root),Buffer.from(png,'base64'));boundary.push({t,name});
 }
 await writeFile(new URL('manifest.json',root),JSON.stringify({created:new Date().toISOString(),fps:30,duration:2.6,source:'Current target.html renderer, no shader replacement',sources,frames,boundary,errors},null,2));
 const cards=frames.map(f=>`<a class="card ${f.mode}" href="${f.name}" target="_blank"><img loading="lazy" src="${f.name}"><span>帧 ${String(f.n).padStart(3,'0')} · ${f.t.toFixed(3)} 秒</span></a>`).join('');
 const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>当前动态逐帧审查 · 2026-09-22</title><style>body{margin:0;background:#15171b;color:#eee;font:16px system-ui}header{padding:20px;position:sticky;top:0;background:#15171bf5;z-index:1}h1{font-size:23px;margin:0 0 10px}p{line-height:1.6;margin:6px 0}button{padding:10px 20px;margin:8px 8px 0 0;cursor:pointer}section{padding:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.card{color:white;text-decoration:none;background:#252931;border-radius:6px;overflow:hidden}.card img{width:100%;display:block}.card span{display:block;padding:10px}.light{display:none}h2{padding:0 20px;font-size:20px}</style><header><h1>当前动态逐帧截图（效果未修改）</h1><p>每秒 30 帧，0–2.600 秒，共 79 帧（含结束帧）。点击任意帧查看 760×760 原图。</p><p>亮底为程序测试背景，非真实摄像头录像。下方另列 0.85 秒切换前后截图。</p><button onclick="setMode('black')">黑底全部帧</button><button onclick="setMode('light')">亮底全部帧</button><a style="color:#9cddff" href="manifest.json">时间与版本记录</a></header><section>${cards}</section><h2>0.85 秒切换点：前后独立采样</h2><section>${boundary.map(f=>`<a class="card" href="${f.name}" target="_blank"><img src="${f.name}"><span>${f.t.toFixed(3)} 秒</span></a>`).join('')}</section><script>function setMode(mode){document.querySelectorAll('.black,.light').forEach(e=>e.style.display=e.classList.contains(mode)?'block':'none')}</script></html>`;
 await writeFile(new URL('index.html',root),html);
 console.log(JSON.stringify({frames:frames.length,boundary:boundary.length,errors,output:root.pathname}));
}finally{await browser.close();}
