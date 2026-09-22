import {readFile,writeFile,mkdir} from 'node:fs/promises';
const pw=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const {chromium}=pw.default??pw;
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage();
 const bytes=await readFile('/Users/bytedance/Desktop/9月16日(3)/9月16日(3)-1.mp4');
 await page.goto('http://127.0.0.1:4177/preview/glow/target.html');
 const result=await page.evaluate(async()=>{
 const v=document.createElement('video');v.muted=true;v.src='/preview/glow/captures/growth-reference/user-original.mp4';await new Promise((resolve,reject)=>{v.onloadeddata=resolve;v.onerror=reject;});
 const c=document.createElement('canvas');c.width=1600;c.height=1290;const x=c.getContext('2d');x.fillStyle='#181818';x.fillRect(0,0,c.width,c.height);
 const raw=document.createElement('canvas');raw.width=raw.height=400;const rx=raw.getContext('2d');let first;const metrics=[];
 for(let i=0;i<12;i++){let t=(v.duration-.01)*i/11;if(t===0)t=.001;v.currentTime=t;await new Promise(r=>v.onseeked=r);const col=i%4,row=Math.floor(i/4);x.drawImage(v,col*400,row*430,400,400);x.fillStyle='white';x.font='20px sans-serif';x.fillText(t.toFixed(3)+'s',col*400+10,row*430+422);rx.drawImage(v,0,0,400,400);const data=rx.getImageData(0,0,400,400).data;if(!first)first=data;let diff=0;for(let j=0;j<data.length;j+=4)diff+=Math.abs(data[j]-first[j])+Math.abs(data[j+1]-first[j+1])+Math.abs(data[j+2]-first[j+2]);metrics.push({t,meanDifference:diff/(400*400*3)});}
 return {duration:v.duration,width:v.videoWidth,height:v.videoHeight,metrics,png:c.toDataURL().split(',')[1]};
 });
 await mkdir(new URL('./captures/growth-reference/',import.meta.url),{recursive:true});
 await writeFile(new URL('./captures/growth-reference/reference-verified.png',import.meta.url),Buffer.from(result.png,'base64'));
 console.log(JSON.stringify({...result,png:undefined}));
}finally{await browser.close();}
