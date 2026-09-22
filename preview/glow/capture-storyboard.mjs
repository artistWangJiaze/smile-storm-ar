import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {imageDifference} from './compare-capture.mjs';
const playwright=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const {chromium}=playwright.default??playwright;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1000,height:1250},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});
const fourthOnly=process.env.FRAME04==='1';
const transitionOnly=process.env.TRANSITION==='1';
const stages=transitionOnly?[
 {t:0.85,title:'03 放射高峰',note:'已确认帧，作为连续变化起点'},
 {t:0.95,title:'03→04 过渡',note:'主体仍亮，外圈开始拉成长颗粒'},
 {t:1.10,title:'04 持续拉散',note:'保留花心和色带，不重新生成实体花纹'},
 {t:1.30,title:'04→05 消散',note:'主体继续减弱，径向颗粒持续外移'},
]:[
 {t:0.20,title:'01 纹饰出现',note:'花心保持大小，外圈紧凑'},
 {t:0.55,title:'02 向外拉伸',note:'外圈径向展开，粒子开始外喷'},
 {t:0.85,title:'03 放射高峰',note:'纹饰被粒子流遮散，花心仍清楚'},
 {t:1.10,title:'04 持续拉散',note:'接参考图 1：不恢复实体花纹'},
 {t:1.40,title:'05 径向展开',note:'接参考图 2：色带延伸、花心开始散开'},
 {t:1.75,title:'06 碎成光粒',note:'接参考图 3：只剩外移的彩色粒子'},
 {t:2.15,title:'07 稀疏余光',note:'接参考图 4：颗粒减少、亮度衰减'},
 {t:2.60,title:'08 完全结束',note:'无底图、无粒子、无残留光晕'},
];
try{
 // Substitute only this headless browser's renderer import. The open user
 // page and its TargetFrame shader are deliberately left unchanged.
 await page.route('**/preview/glow/GlowPreviewRenderer.ts*',async route=>{
  const response=await route.fetch();const body=await response.text();
  const match=/import\s*\{\s*storyboardVertex\s+as\s+motionVertex\s*,\s*targetBodyFragment\s*\}\s*from\s*["'][^"']*FourthFrame(?:\.ts)?(?:\?[^"']*)?["']/;
  assert.ok(match.test(body),'Renderer import not found: '+body.slice(0,1000));
  const shader=fourthOnly||transitionOnly?'FourthFrame':'StoryboardFrame';
  await route.fulfill({response,body:body.replace(match,`import { storyboardVertex as motionVertex, targetBodyFragment } from "/preview/glow/${shader}.ts"`)});
 });
 await page.goto('http://localhost:4177/preview/glow/target.html');
 await page.waitForFunction(()=>window.targetStudy?.ready,{},{timeout:15000});
 const frames=[];
 for(const stage of stages.filter(s=>!fourthOnly||s.t<=1.10)){
  const result=await page.evaluate(t=>{
   const s=window.targetStudy;s.seek(t);s.renderer.refreshBackground();
   const c=document.createElement('canvas');c.width=c.height=760;const x=c.getContext('2d');x.drawImage(s.renderer.element,0,0);
   const pixels=x.getImageData(0,0,760,760).data;let peak=0;for(let i=0;i<pixels.length;i+=4)peak=Math.max(peak,pixels[i],pixels[i+1],pixels[i+2]);
   return {png:c.toDataURL().split(',')[1],peak,error:s.renderer.element.getContext('webgl2').getError()};
  },stage.t);
  assert.equal(result.error,0);if(stage.t===2.6)assert.equal(result.peak,0);
  if(stage.t<=0.85){
   const old=(await readFile(new URL(`./captures/storyboard-${stage.t.toFixed(2)}.png`,import.meta.url))).toString('base64');
   const d=await imageDifference(page,result.png,old);
   assert.ok(d.mean<0.01&&d.changedRatio<0.005,`Approved first frames changed: ${JSON.stringify(d)}`);
  }
  const series=transitionOnly?'transition-v2':fourthOnly?'v3':'v2';
  await writeFile(new URL(`./captures/storyboard-${series}-${stage.t.toFixed(2)}.png`,import.meta.url),Buffer.from(result.png,'base64'));
  frames.push({...stage,png:result.png});
 }
 if(transitionOnly){
  const png=await page.evaluate(async frames=>{
   const c=document.createElement('canvas');c.width=1240;c.height=1260;const x=c.getContext('2d');
   x.fillStyle='#101216';x.fillRect(0,0,c.width,c.height);
   x.fillStyle='#f6f6f8';x.font='bold 36px system-ui';x.fillText('03 → 04 连续变化 · 实际代码帧',36,56);
   x.fillStyle='#b7beca';x.font='22px system-ui';x.fillText('同一套粒子与光效参数 / 不改正式 AR / 四帧不覆盖，可逐张检查',36,94);
   for(let i=0;i<frames.length;i++){
    const f=frames[i],im=new Image();im.src='data:image/png;base64,'+f.png;await im.decode();
    const left=36+(i%2)*600,top=126+Math.floor(i/2)*555;
    x.drawImage(im,left,top,540,540);
    x.fillStyle='#f6f6f8';x.font='bold 24px system-ui';x.fillText(f.title,left,top+575);
    x.fillStyle='#7ddad2';x.font='21px system-ui';x.fillText(f.t.toFixed(2)+' s',left+445,top+575);
    x.fillStyle='#b7beca';x.font='18px system-ui';x.fillText(f.note,left,top+607);
   }
   return c.toDataURL().split(',')[1];
  },frames);
  await writeFile(new URL('./captures/storyboard-03-04-transition-v2.png',import.meta.url),Buffer.from(png,'base64'));
  assert.deepEqual(errors,[]);console.log('PASS: four actual-code transition frames; approved frame 03 preserved; no shader errors; main preview unchanged.');
  process.exitCode=0;
 }else if(fourthOnly){
  const reference=(await readFile('/var/folders/yx/kt_vywvn3b7_k34bc466rphh0000gn/T/codex-clipboard-b71296c2-4c3a-4f2f-8173-7f517ee406da.png')).toString('base64');
  const old=(await readFile(new URL('./captures/storyboard-v2-1.10.png',import.meta.url))).toString('base64');
  const png=await page.evaluate(async({reference,old,current})=>{
   const c=document.createElement('canvas');c.width=1740;c.height=730;const x=c.getContext('2d');x.fillStyle='#101216';x.fillRect(0,0,c.width,c.height);
   x.fillStyle='white';x.font='bold 30px system-ui';x.fillText('04 单帧校对 · 保留拉伸中的纹饰结构',26,45);
   x.fillStyle='#b7beca';x.font='20px system-ui';x.fillText('仅修订第 04 格 / 新图为实际代码渲染 / 尚未验证前后连续运动，不替换当前页面',26,82);
   const pictures=[reference,old,current],titles=['你的参考（中心裁切）','上一版 04：结构过早打散','修订 04：径向拉伸的细颗粒纹饰'];
   for(let i=0;i<3;i++){const im=new Image();im.src='data:image/png;base64,'+pictures[i];await im.decode();const side=Math.min(im.width,im.height);x.drawImage(im,(im.width-side)/2,(im.height-side)/2,side,side,26+i*574,108,540,540);x.fillStyle='white';x.font='22px system-ui';x.fillText(titles[i],26+i*574,692);}
   return c.toDataURL().split(',')[1];
  },{reference,old,current:frames.at(-1).png});
  await writeFile(new URL('./captures/storyboard-04-comparison.png',import.meta.url),Buffer.from(png,'base64'));
  assert.deepEqual(errors,[]);console.log('PASS: first three frames preserved; frame 04 rendered in isolated shader; main preview unchanged.');
  process.exitCode=0;
 }else{
 const png=await page.evaluate(async frames=>{
  const c=document.createElement('canvas');c.width=1840;c.height=1220;const x=c.getContext('2d');
  x.fillStyle='#101216';x.fillRect(0,0,c.width,c.height);
  x.fillStyle='#f6f6f8';x.font='bold 36px system-ui';x.fillText('烟花展开 · 修订分镜 02',36,56);
  x.fillStyle='#b7beca';x.font='22px system-ui';x.fillText('从左到右，再看下一行 / 前三格保留 / 第三格后持续拉散，不再恢复完整纹饰 / 实际代码渲染',36,94);
  for(let i=0;i<frames.length;i++){
   const f=frames[i],im=new Image();im.src='data:image/png;base64,'+f.png;await im.decode();
   const left=36+(i%4)*450,top=126+Math.floor(i/4)*535;
   x.drawImage(im,left,top,420,420);
   x.fillStyle='#f6f6f8';x.font='bold 24px system-ui';x.fillText(f.title,left,top+458);
   x.fillStyle='#7ddad2';x.font='21px system-ui';x.fillText(f.t.toFixed(2)+' s',left+335,top+458);
   x.fillStyle='#b7beca';x.font='19px system-ui';x.fillText(f.note,left,top+494);
  }
  return c.toDataURL().split(',')[1];
 },frames);
 await writeFile(new URL('./captures/storyboard-motion-v2.png',import.meta.url),Buffer.from(png,'base64'));
 assert.deepEqual(errors,[]);console.log('PASS: eight actual WebGL frames; first three match approved captures within subpixel tolerance; no shader errors; final frame black; current preview unchanged.');
 }
}finally{await browser.close();}
