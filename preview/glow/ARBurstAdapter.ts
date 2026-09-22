import { GlowPreviewRenderer } from './GlowPreviewRenderer';
import type { HeadCollider } from '../../src/types';
import { handControl, handAnimationAge } from '../../src/HandControl';
import { easterEgg } from '../../src/EasterEgg';

// Local integration gate: retains the established rocket/expression pipeline.
// The approved trajectory and the existing persistent collision solver share
// the same visible particles. Palette selection is preserved per burst.
export class ARBurstAdapter {
 private readonly renderer:GlowPreviewRenderer;
 private time=0;
 private width=1;
 private height=1;
 private nextId=1;
 private handWasActive=false;
 private eggBurstId:number|null=null;
 private bursts:Array<{id:number;start:number;x:number;y:number;palette:number;age:number;angle:number}>=[];
 constructor(mount:HTMLElement){
  this.renderer=new GlowPreviewRenderer(mount);
  this.renderer.setBackground('transparent');
 }
 resize(width:number,height:number){this.width=width;this.height=height;this.renderer.resize(width,height);}
 burst(x:number,y:number,palette:number){
  if(!this.available)return;
  if(this.eggBurstId!==null && (easterEgg.pending||easterEgg.active)) return;
  if(handControl.active && this.bursts.length && !easterEgg.pending) return;
  if(this.bursts.length>=4)this.bursts.shift();
  this.bursts.push({id:this.nextId++,start:this.time,x,y,palette:Math.abs(palette)%3,age:0,angle:0});
  if(easterEgg.pending){
    this.bursts=this.bursts.slice(-1);
    this.eggBurstId=this.bursts[0].id;
    this.renderer.resetARContacts();
  }
 }
 update(time:number,head:HeadCollider|null,vx=0,vy=0,dt=1/60){
  this.time=time;
  if(handControl.active&&!this.handWasActive){
    // Reconstitute the original flower, including particles already bounced.
    this.renderer.resetARContacts();
    // One controlled flower, not several overlapping expression-triggered bursts.
    this.bursts=this.bursts.slice(-1);
  }
  this.handWasActive=handControl.active;
  for(const b of this.bursts){
    if(b.id===this.eggBurstId && easterEgg.pending){
      b.age=Math.min(.85,b.age+dt);
      if(b.age>=.85)easterEgg.bloomReady();
    } else if(b.id===this.eggBurstId && easterEgg.active && (!handControl.active||easterEgg.holding)) {
      // Keep the lesson's flower available during hand loss; resume on reacquisition.
    } else if(handControl.active){
      const target=handAnimationAge(handControl.openness);
      b.age+=(target-b.age)*(1-Math.exp(-dt*9));
      if(Math.abs(target-b.age)<.002)b.age=target;
      const delta=Math.atan2(Math.sin(handControl.angle-b.angle),Math.cos(handControl.angle-b.angle));
      b.angle+=delta*(1-Math.exp(-dt*10));
    } else b.age+=dt;
  }
  this.bursts=this.bursts.filter(b=>handControl.active||b.age<2.6);
  const noCollision=handControl.active||easterEgg.active||easterEgg.pending;
  const before=this.renderer.arBouncedCount;
  this.renderer.renderTargetFrame(0,false,true,this.bursts.map(b=>({...b,extent:Math.min(this.width,this.height)*1.05})),noCollision?null:head,noCollision?0:vx,noCollision?0:vy,dt);
  return Math.max(0,this.renderer.arBouncedCount-before);
 }
 get available(){return this.renderer.ready;}
 get bouncedCount(){return this.renderer.arBouncedCount;}
 get activeCount(){return this.bursts.length*270000;}
 dispose(){this.bursts=[];this.renderer.dispose();}
}
