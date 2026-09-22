/// <reference types="vite/client" />
import { GlowPreviewRenderer } from './GlowPreviewRenderer';
const renderer=new GlowPreviewRenderer(document.getElementById('stage')!);
renderer.resize(760,760);
const video=document.getElementById('camera') as HTMLVideoElement;
const cameraButton=document.getElementById('camera-button') as HTMLButtonElement;
const blackButton=document.getElementById('black') as HTMLButtonElement;
const cameraStatus=document.getElementById('camera-status')!;
let ready=false,active=true,cameraRequest=0;
let stream:MediaStream|null=null;
const duration=2.6;
const playButton=document.getElementById('play') as HTMLButtonElement;
const timeline=document.getElementById('timeline') as HTMLInputElement;
const timeLabel=document.getElementById('time')!;
let playing=false,dynamic=false,time=0.85,lastTick=performance.now();
function syncPlayback(){
  playButton.textContent=playing?'暂停':'播放动态';
  playButton.setAttribute('aria-pressed',String(playing));
  timeline.value=String(time);timeLabel.textContent=`${time.toFixed(2)} / ${duration.toFixed(2)} 秒`;
}
function seek(seconds:number){
  if(!ready)return;
  playing=false;dynamic=true;time=Math.max(0,Math.min(duration,seconds));
  renderMotion();
}
function renderMotion(){
  renderer.renderTargetFrame(time,false,true);syncPlayback();
  document.getElementById('target')!.setAttribute('aria-pressed','false');
  document.getElementById('previous')!.setAttribute('aria-pressed','false');
  document.getElementById('status')!.textContent=time>=duration?'已消散，可重新播放。':time<0.85?'绽放：向外展开。':time<1.5?'扩散：保留彩色亮部，继续向外运动。':'消散：粒子分批熄灭，不保留纹饰底图。';
}
function start(){
  if(!ready)return;
  if(!dynamic||time>=duration)time=0;
  dynamic=true;playing=true;lastTick=performance.now();syncPlayback();
}
playButton.onclick=()=>{if(playing){playing=false;syncPlayback();}else start();};
document.getElementById('replay')!.onclick=()=>{seek(0);start();};
timeline.oninput=()=>seek(Number(timeline.value));
function show(target=true){
  if(!ready)return;
  playing=false;dynamic=false;time=target?0.85:1.35;syncPlayback();
  if(target)renderer.renderTargetFrame(0.85,false,true);
  else {renderer.restart(0);renderer.setCompositeMode('colour-glow');for(let i=1;i<=81;i++)renderer.update(i/60,null,0,0,1/60);}
  document.getElementById('target')!.setAttribute('aria-pressed',String(target));
  document.getElementById('previous')!.setAttribute('aria-pressed',String(!target));
  document.getElementById('status')!.textContent=target?'新小样：固定爆发画面，保持已确认的粒子与光效。':'对照：上一版动画的 1.35 秒。';
}
document.getElementById('target')!.onclick=()=>show(true);
document.getElementById('previous')!.onclick=()=>show(false);
function stopCamera(){
  cameraRequest++;stream?.getTracks().forEach(t=>t.stop());stream=null;
  video.pause();video.srcObject=null;
  cameraButton.disabled=false;cameraButton.textContent='开启摄像头背景';
  cameraButton.setAttribute('aria-pressed','false');blackButton.setAttribute('aria-pressed','true');
  renderer.setBackground('black');cameraStatus.textContent='黑底。摄像头只在点击后开启，不录制、不上传。';
}
blackButton.onclick=stopCamera;
cameraButton.onclick=async()=>{
  if(!ready||stream)return;
  const request=++cameraRequest;cameraButton.disabled=true;cameraButton.textContent='等待摄像头权限…';
  let pending:MediaStream|null=null;
  try{
    pending=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});
    if(!active||request!==cameraRequest){pending.getTracks().forEach(t=>t.stop());return;}
    stream=pending;video.srcObject=stream;await video.play();
    if(!active||request!==cameraRequest)return;
    renderer.setBackground('camera',video);
    cameraButton.textContent='摄像头背景已开启';cameraButton.setAttribute('aria-pressed','true');
    blackButton.setAttribute('aria-pressed','false');
    cameraStatus.textContent='摄像头背景已开启。可播放动态或查看确认帧；没有人脸跟踪或碰撞。';
  }catch{
    pending?.getTracks().forEach(t=>t.stop());
    if(request===cameraRequest){stopCamera();cameraStatus.textContent='摄像头未开启。请允许权限后重试，或继续查看黑底。';}
  }finally{if(active&&request===cameraRequest)cameraButton.disabled=false;}
};
const started=performance.now();
function frame(now:number){
  if(!active)return;
  if(!ready&&renderer.ready){ready=true;show();}
  else if(!ready&&performance.now()-started>15000){document.getElementById('status')!.textContent='未能载入 WebGL 小样，请刷新重试。';return;}
  if(ready&&playing){
    time=Math.min(duration,time+(now-lastTick)/1000);
    if(time>=duration)playing=false;
    renderMotion();
  }else if(ready&&stream)renderer.refreshBackground();
  lastTick=now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
Object.assign(window,{targetStudy:{renderer,show,seek,start,get ready(){return ready;},get time(){return time;},get playing(){return playing;}}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){playing=false;syncPlayback();}});
function dispose(){active=false;stopCamera();renderer.dispose();}
window.addEventListener('pagehide',dispose,{once:true});
if(import.meta.hot)import.meta.hot.dispose(dispose);
