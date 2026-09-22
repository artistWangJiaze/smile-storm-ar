import { GlowPreviewRenderer } from './GlowPreviewRenderer';
const old=new GlowPreviewRenderer(document.getElementById('old')!);
const current=new GlowPreviewRenderer(document.getElementById('new')!);
old.resize(760,760);current.resize(760,760);
let time=0,playing=true,last=performance.now(),ready=false,light=false;
const slider=document.getElementById('seek') as HTMLInputElement;
const play=document.getElementById('play')!;
function render(){old.renderTargetFrame(time);current.renderTargetFrame(time,true);slider.value=String(time);document.getElementById('time')!.textContent=`${time.toFixed(3)} 秒 · 帧 ${(time*30).toFixed(1)}`;}
function seek(t:number){playing=false;play.textContent='播放';time=Math.max(0,Math.min(.85,t));render();}
slider.oninput=()=>seek(Number(slider.value));
play.onclick=()=>{playing=!playing;play.textContent=playing?'暂停':'播放';last=performance.now();};
document.getElementById('restart')!.onclick=()=>{time=0;playing=true;play.textContent='暂停';last=performance.now();};
document.getElementById('background')!.onclick=()=>{light=!light;old.setBackground(light?'light':'black');current.setBackground(light?'light':'black');};
function frame(now:number){if(old.ready&&current.ready){if(!ready){ready=true;document.getElementById('status')!.textContent='本页为真实代码渲染；循环末尾短暂停留后重新开始。';render();}if(playing){time+=(now-last)/1000*Number((document.getElementById('speed') as HTMLSelectElement).value);if(time>1.08)time=0;const actual=time;time=Math.min(time,.85);render();time=actual;}}last=now;requestAnimationFrame(frame);}
requestAnimationFrame(frame);
Object.assign(window,{growthStudy:{old,current,seek,get ready(){return ready;}}});
window.addEventListener('pagehide',()=>{old.dispose();current.dispose();});
