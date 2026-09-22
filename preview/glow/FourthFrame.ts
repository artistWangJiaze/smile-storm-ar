import { storyboardVertex as previous } from './StoryboardFrame';

// Continuous colour-and-volume layer. It inverse-maps each output pixel back
// into the ornament, preserving broad pink/green/gold regions while opening
// the middle rings radially. Fine breakup grows only after frame 04; the point
// pass below supplies the separate sparks and long rays.
export const targetBodyFragment = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform float uTime;
in vec2 vUv;
out vec4 outColor;
float hash21(vec2 p){
  p=fract(p*vec2(123.34,456.21));
  p+=dot(p,p+45.32);
  return fract(p.x*p.y);
}
float mappedRadius(float r,float dissolve){
  float core=0.038;
  if(r<=core)return r*0.84;
  float unit=clamp((r-core)/(0.50-core),0.0,1.0);
  float linear=r*0.84;
  float warp=core+(0.525+0.16*dissolve-core)*pow(unit,0.61);
  return mix(linear,warp,smoothstep(0.10,0.34,r));
}
void main(){
  float phase=smoothstep(0.85,1.10,uTime);
  if(phase<=0.0001){outColor=vec4(0);return;}
  float dissolve=smoothstep(0.86,1.60,uTime);
  vec2 q=vUv-0.5;
  float radius=length(q);
  if(radius>0.535){outColor=vec4(0);return;}
  vec2 dir=radius>0.0001?q/radius:vec2(1,0);
  float lo=0.0,hi=0.51;
  for(int i=0;i<10;i++){
    float mid=(lo+hi)*0.5;
    if(mappedRadius(mid,dissolve)<radius)lo=mid;else hi=mid;
  }
  float sourceRadius=(lo+hi)*0.5;
  float angular=atan(dir.y,dir.x);
  float rayNoise=sin(angular*47.0+sourceRadius*173.0)*0.5+0.5;
  float cell=hash21(floor(vUv*900.0));
  sourceRadius+=phase*(rayNoise-0.5)*0.007*smoothstep(0.10,0.34,sourceRadius);
  float blurSpan=phase*smoothstep(0.07,0.30,sourceRadius)*(0.018+0.042*dissolve);
  float angularSpan=phase*(0.030+0.085*dissolve);
  vec3 source=vec3(0);
  float weightSum=0.0;
  for(int i=-3;i<=3;i++){
    float unit=float(i)/3.0;
    float weight=1.0-0.16*abs(float(i));
    float turn=unit*angularSpan;
    vec2 sampleDir=mat2(cos(turn),-sin(turn),sin(turn),cos(turn))*dir;
    vec2 uv=0.5+sampleDir*max(0.0,sourceRadius+unit*blurSpan);
    source+=texture(uImage,vec2(uv.x,1.0-uv.y)).rgb*weight;
    weightSum+=weight;
  }
  source/=weightSum;
  float maximum=max(max(source.r,source.g),source.b);
  float pigment=smoothstep(0.12,0.42,maximum);
  float breakup=mix(1.0,smoothstep(dissolve*0.72,1.0,cell),dissolve*0.72);
  float radialFade=1.0-smoothstep(0.49,0.535,radius);
  float endFade=1.0-smoothstep(1.65,2.55,uTime);
  float opacity=pigment*breakup*radialFade*phase*(0.40-0.12*dissolve)*endFade;
  vec3 colour=pow(source/max(maximum,0.0001),vec3(1.65));
  float luminance=pow(maximum,1.75);
  vec3 light=colour*luminance*(0.58+0.18*rayNoise);
  outColor=vec4(light*opacity,opacity*0.24);
}`;

// Isolated frame-04 shape study: no main-preview imports. The fourth frame is
// the original ornament pulled through a non-linear polar map. A dense body,
// short radial fragments and sparse dust share the same source lattice, so the
// image cannot turn into repeated rings or a newly reconstituted mandala.
const sharedSource = previous.replace(`  if(layer>0){
    float theta=uv.x*6.2831853;
    float radius=mix(0.10,0.50,uv.y);
    uv=0.5+vec2(cos(theta),sin(theta))*radius;
  }`, `  if(layer>0){
    if(uTime<=0.85){
      float theta=uv.x*6.2831853;
      float radius=mix(0.10,0.50,uv.y);
      uv=0.5+vec2(cos(theta),sin(theta))*radius;
    }else{
      // From frame 04 onward every layer samples the same ornament. Tiny
      // sub-pixel offsets avoid stacked dots without duplicating its motifs.
      float sx=hash(float(id)*1.31+float(layer)*37.0)-0.5;
      float sy=hash(float(id)*2.17+float(layer)*83.0)-0.5;
      uv+=vec2(sx,sy)/300.0;
    }
  }`);

const insertion = `
  float fourth=smoothstep(0.85,1.30,t);
  float dissolve=smoothstep(1.10,1.55,t);
  if(fourth>0.0){
    float coreEdge=0.038;
    float radialUnit=clamp((r-coreEdge)/(0.50-coreEdge),0.0,1.0);
    // The centre remains continuous. The deformation blends into an
    // accelerating radial map only across the middle rings, so no empty hole
    // appears between the flower core and its stretched coloured bands.
    float linearRadius=r*0.84;
    float warpRadius=coreEdge+(0.525-coreEdge)*pow(radialUnit,0.61);
    float warpMix=smoothstep(0.10,0.34,r);
    float bodyRadius=r<=coreEdge?linearRadius:mix(linearRadius,warpRadius,warpMix);
    float fine=hash(float(id)*2.31+float(layer)*71.0);
    float side=hash(float(id)*4.17+float(layer)*29.0)-0.5;
    float bodyNoise=(fine-0.5)*0.020*outer;
    float fragment=outer*(0.012+pow(fine,1.45)*0.115);
    float dust=outer*(0.040+pow(fine,1.12)*0.245);
    float offset=(layer==0?bodyNoise:(layer==1?fragment:dust))*(1.0+0.75*dissolve);
    vec2 stretched=dir*(bodyRadius+offset);
    stretched+=tangent*side*outer*(layer==0?0.007:(layer==1?0.015:0.030));
    float late=max(t-1.10,0.0);
    stretched+=dir*late*outer*(0.08+0.18*fine);
    stretched+=tangent*side*late*outer*0.025;
    float endFade=1.0-smoothstep(1.65,2.55,t);
    float bodyEnergy=mix(0.30,0.05,outer)*(1.0-0.70*dissolve);
    float fragmentEnergy=step(0.18,fine)*0.42*(1.0-0.18*dissolve);
    float dustEnergy=step(0.45,fine)*0.24;
    bodyEnergy*=endFade;
    fragmentEnergy*=endFade;
    dustEnergy*=endFade;
    pose=mix(pose,stretched,fourth);
    life=mix(life,layer==0?bodyEnergy:(layer==1?fragmentEnergy:dustEnergy),fourth);
  }
`;

export const storyboardVertex = sharedSource
  .replace('  vec2 world=', insertion+'  vec2 world=')
  .replace('  gl_PointSize=max(lengthPx,widthPx)*uPixelRatio;', `
  lengthPx=mix(lengthPx,layer==0?3.2:(layer==1?8.4:5.2),fourth);
  widthPx=mix(widthPx,layer==0?3.2:(layer==1?1.6:1.0),fourth);
  gl_PointSize=max(lengthPx,widthPx)*uPixelRatio;`)
  .replace('  vSpark=layer==1?0.92:0.60;', `
  vAspect=max(lengthPx/widthPx,1.0);
  vSpark=mix(layer==1?0.92:0.60,layer==0?0.06:(layer==1?0.62:0.82),fourth);`)
  .replace('  float bright=pow(maximum,2.2);', `
  colour=mix(colour,pow(source/max(maximum,0.0001),vec3(1.90)),fourth);
  float bright=pow(maximum,2.2);`)
  .replace('  float gain=layer==0?7.0:(layer==1?mix(1.0,7.0,hot):0.65);', `
  float gain=layer==0?7.0:(layer==1?mix(1.0,7.0,hot):0.65);
  gain=mix(gain,layer==0?4.10:(layer==1?2.05:0.92),fourth);`);
