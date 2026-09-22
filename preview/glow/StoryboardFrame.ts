import { targetVertex } from './TargetFrame';
export { targetBodyFragment } from './TargetFrame';

// Isolated storyboard proposal. Not imported by the current preview page.
// Reuses its actual HDR rendering and original ornament; no generated image.
const start = targetVertex.indexOf('  float life=1.0;');
const end = targetVertex.indexOf('  vec2 world=', start);
if (start < 0 || end < 0) throw new Error('Target shader structure changed');
export const storyboardVertex = targetVertex.slice(0, start) + `
  float t=max(uTime,0.0);
  // Preserve frames 1–3, then continue dispersing. Never restore body gain.
  float formative=min(t,0.85);
  float expand=smoothstep(0.2,1.5,formative);
  float pulse=smoothstep(0.25,0.75,formative);
  float after=max(t-0.85,0.0);
  float finish=smoothstep(1.65,2.5,t);
  // The small central petals stay put. Radial spacing grows outside them;
  // this is not a common scale applied to the entire flower.
  float anchor=0.080;
  float extent=mix(0.50,0.80,expand);
  float radius=r<=anchor?r:anchor+(r-anchor)*extent;
  pose=dir*radius;
  float life=smoothstep(0.0,0.12,t);
  if(layer==0){
    pose+=tangent*(m-0.5)*0.003*outer;
    // Coherent body never reappears after the peak: its own samples stretch
    // into radial dust, instead of exposing a hidden crisp ornament underneath.
    life*=mix(1.0,mix(0.32,0.52,expand)*(1.0-0.88*pulse),outer);
  }else{
    float release=smoothstep(0.12,0.55,t);
    float flight=max(t-0.25,0.0);
    float distance=outer*(0.014+flight*(0.07+0.15*n))*float(layer);
    pose+=dir*distance;
    pose+=tangent*(m-0.5)*outer*(0.003+flight*0.012);
    // Distributed particles make a thick coloured streak, not one long line.
    life*=release*mix(0.30,1.10,pulse)*(1.0-0.15*smoothstep(1.2,1.8,t));
  }
  float breakCore=smoothstep(1.0,1.65,t);
  float mobility=mix(outer,1.0,breakCore);
  pose+=dir*after*mobility*(0.035+0.12*n);
  pose+=tangent*(m-0.5)*after*mobility*0.022;
  // Keep coloured spokes while widening their radial distribution. The
  // initially stable central petals join the same outward flow, then expire.
  life*=1.0-0.15*smoothstep(0.85,1.8,t);
  pose+=dir*outer*finish*(0.06+0.16*n);
  pose.y+=finish*finish*0.025*m;
  float death=2.05+0.50*m;
  life*=1.0-smoothstep(death-0.5,death,t);
  if(life<=0.0){gl_Position=vec4(2);gl_PointSize=1.0;return;}
` + targetVertex.slice(end);
