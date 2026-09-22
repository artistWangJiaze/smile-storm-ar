import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1000,height:1100},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});
try{
 await page.goto('http://localhost:4177/preview/glow/target.html');
 await page.waitForFunction(()=>window.targetStudy?.ready,{},{timeout:15000});
 for(const target of [true,false]){
  const data=await page.evaluate(target=>{const s=window.targetStudy;s.show(target);const c=document.createElement('canvas');c.width=760;c.height=760;c.getContext('2d').drawImage(s.renderer.element,0,0,760,760);return {png:c.toDataURL().split(',')[1],error:s.renderer.element.getContext('webgl2').getError()};},target);
  assert.equal(data.error,0);
  await writeFile(new URL(`./captures/target-${target?'new':'previous'}.png`,import.meta.url),Buffer.from(data.png,'base64'));
 }
 await page.getByRole('button',{name:'新小样 · 密集短火花'}).click();
 await page.screenshot({path:new URL('./captures/target-page.png',import.meta.url).pathname,fullPage:true});
 assert.deepEqual(errors,[]);console.log('PASS: actual WebGL target / previous captures; no shader or page errors.');
}finally{await browser.close();}
