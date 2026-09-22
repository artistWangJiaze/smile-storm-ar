import {mkdir,writeFile} from 'node:fs/promises';
const pw=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const {chromium}=pw.default??pw;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const root=new URL('./captures/growth-v1/',import.meta.url);await mkdir(root,{recursive:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto('http://127.0.0.1:4177/preview/glow/growth.html');await page.waitForFunction(()=>window.growthStudy?.ready);
 const frames=[];
 for(let i=0;i<=26;i++){
  const t=i===26?.85:i/30;
  const result=await page.evaluate(t=>{const s=window.growthStudy;s.seek(t);const c=document.createElement('canvas');c.width=1520;c.height=800;const x=c.getContext('2d');x.fillStyle='#16191e';x.fillRect(0,0,1520,800);x.drawImage(s.old.element,0,0);x.drawImage(s.current.element,760,0);x.fillStyle='white';x.font='24px sans-serif';x.fillText('OLD   '+t.toFixed(3)+'s',15,786);x.fillText('NEW   '+t.toFixed(3)+'s',775,786);const p=x.getImageData(0,0,1520,760).data;let diff=0;for(let y=0;y<760;y++)for(let xx=0;xx<760;xx++)for(let k=0;k<3;k++)diff+=Math.abs(p[(y*1520+xx)*4+k]-p[(y*1520+xx+760)*4+k]);return {png:c.toDataURL().split(',')[1],difference:diff/(760*760*3)};},t);
  const name=`frame-${String(i).padStart(2,'0')}.png`;await writeFile(new URL(name,root),Buffer.from(result.png,'base64'));frames.push({i,t,name,difference:result.difference});
 }
 const sheet=await page.evaluate(async frames=>{const c=document.createElement('canvas');c.width=1520;c.height=1600;const x=c.getContext('2d');for(let i=0;i<4;i++){const img=new Image();img.src='/preview/glow/captures/growth-v1/'+frames[[5,10,17,25][i]].name;await img.decode();x.drawImage(img,0,i*400,1520,400);}return c.toDataURL().split(',')[1];},frames);
 await writeFile(new URL('overview.png',root),Buffer.from(sheet,'base64'));
 await writeFile(new URL('index.html',root),`<!doctype html><meta charset="utf-8"><title>前段逐帧对照</title><style>body{background:#17191f;color:white;font:18px system-ui;margin:20px}img{width:100%;max-width:1520px}a{color:#9cdaff}</style><h1>左旧版／右新版：0–25 帧与 0.85 秒端点</h1><p><a href="../../growth.html">返回动态对照</a> · 每张图可点击看原尺寸</p>${frames.map(f=>`<h2>帧 ${f.i} · ${f.t.toFixed(3)} 秒</h2><a href="${f.name}"><img loading="lazy" src="${f.name}"></a>`).join('')}`);
 await writeFile(new URL('verification.json',root),JSON.stringify({errors,frames},null,2));
 console.log(JSON.stringify({errors,startDifference:frames[0].difference,midDifference:frames[12].difference,peakDifference:frames[26].difference}));
 if(errors.length||frames[26].difference>.02)process.exitCode=1;
}finally{await browser.close();}
