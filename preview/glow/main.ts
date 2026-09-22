import { GlowPreviewRenderer } from './GlowPreviewRenderer';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const renderer = new GlowPreviewRenderer($('mount'));
// Fixed logical canvas: resizing the page only scales the preview, not physics.
renderer.resize(760,760);
let time=0, playing=true, previous=0, palette=0, loaded=false;
let cameraStream: MediaStream|null=null;
const status=$('status'), seek=$<HTMLInputElement>('seek'), play=$<HTMLButtonElement>('play');
function restart(){renderer.restart(palette);time=0;}
function renderStep(dt:number){time+=dt;renderer.update(time,null,0,0,dt);}
function updateReadout(){seek.value=String(time);$('time').textContent=`${time.toFixed(2)} 秒`;}
function frame(now:number){
  const dt=previous?Math.min((now-previous)/1000,1/30):1/60;previous=now;
  if(renderer.ready&&!loaded){loaded=true;restart();status.textContent=renderer.hdrEnabled?'实时光效 · 纹饰粒子、拖尾与光晕独立计算':'当前设备不支持此预览所需的高动态范围渲染';}
  if(loaded&&playing){if(time>4.2)restart();renderStep(dt);updateReadout();}
  else if(loaded) renderer.refreshBackground();
  requestAnimationFrame(frame);
}
play.onclick=()=>{playing=!playing;play.textContent=playing?'暂停':'播放';};
$('restart').onclick=()=>{restart();playing=true;play.textContent='暂停';};
function composite(mode:'current'|'colour-glow'){
  renderer.setCompositeMode(mode);
  $('current').setAttribute('aria-pressed',String(mode==='current'));
  $('colour-glow').setAttribute('aria-pressed',String(mode==='colour-glow'));
  $('comparison').textContent=mode==='current'?'A · 上一版：只提亮背景，作为对照。':'B · 彩色粒子局部覆盖背景，再叠加光效；不压暗整幅画面。';
}
$('current').onclick=()=>composite('current');$('colour-glow').onclick=()=>composite('colour-glow');
$<HTMLSelectElement>('palette').onchange=e=>{palette=Number((e.target as HTMLSelectElement).value);restart();};
function scrub(target:number){restart();for(let t=0;t<target-1e-6;){const dt=Math.min(1/60,target-t);renderStep(dt);t+=dt;}updateReadout();}
seek.oninput=()=>{playing=false;play.textContent='播放';scrub(Number(seek.value));};
function background(mode:'black'|'light'|'camera'){
  $('stage').classList.toggle('light',mode==='light');
  // The video supplies a GPU texture, not a separately alpha-composited DOM layer.
  $('camera').style.display='none';
  renderer.setBackground(mode,mode==='camera'?$<HTMLVideoElement>('camera'):null);
  $('black').setAttribute('aria-pressed',String(mode==='black'));
  $('light').setAttribute('aria-pressed',String(mode==='light'));
  if(mode!=='camera'&&cameraStream){cameraStream.getTracks().forEach(t=>t.stop());cameraStream=null;$<HTMLVideoElement>('camera').srcObject=null;}
}
$('black').onclick=()=>background('black');$('light').onclick=()=>background('light');
$('webcam').onclick=async()=>{try{cameraStream??=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});const v=$<HTMLVideoElement>('camera');v.srcObject=cameraStream;await v.play();background('camera');status.textContent='摄像头仅作背景，当前预览不进行人脸识别';}catch{status.textContent='未开启摄像头，可以先用黑底 / 亮底查看';}};
window.addEventListener('pagehide',()=>{cameraStream?.getTracks().forEach(t=>t.stop());renderer.dispose();});
// Capture hooks render the same code and deterministic frame sequence as UI.
Object.assign(window,{glowPreview:{renderer,get ready(){return loaded;},pause(){playing=false;play.textContent='播放';},setPalette(p:number){palette=p;restart();},seek:scrub,step:renderStep,background,composite,get time(){return time;}}});
requestAnimationFrame(frame);
