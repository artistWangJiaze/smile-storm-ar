// Optional full-screen ornament body. The approved target and current preview
// remain point-only; isolated storyboard studies may provide a fragment pass.
export const targetBodyFragment: string | null = null;

// Deterministic visual study. Negative time retains the approved fixed pose.
// Positive time adds analytic expansion/dispersion, not head collision physics.
// Three deterministic samples of the existing ornament supply a dense body,
// fragmented hot sparks and a lower-energy outer spray. No generated bitmap.
export const targetVertex = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uImage;
uniform vec2 uViewport;
uniform float uPixelRatio;
uniform int uLayer;
uniform float uTime;
out vec3 vEmission;
out vec2 vDirection;
out float vAspect;
out float vSpark;
out float vCoverage;
float hash(float n){
  vec3 p=fract(vec3(n)*vec3(0.1031,0.1030,0.0973));
  p+=dot(p,p.yzx+33.33);
  return fract((p.x+p.y)*p.z);
}
void main(){
  int layer=uLayer;
  int id=gl_VertexID;
  vec2 uv=(vec2(float(id%300),float(id/300))+0.5)/300.0;
  if(layer>0){
    float theta=uv.x*6.2831853;
    float radius=mix(0.10,0.50,uv.y);
    uv=0.5+vec2(cos(theta),sin(theta))*radius;
  }
  vec3 source=texture(uImage,vec2(uv.x,1.0-uv.y)).rgb;
  float maximum=max(max(source.r,source.g),source.b);
  vec2 p=uv-0.5;float r=length(p);
  float outer=smoothstep(0.095,0.19,r);
  float n=hash(float(id)+float(layer)*12983.0);
  float m=hash(float(id)*1.7+float(layer)*191.0);
  vEmission=vec3(0);vCoverage=0.0;vAspect=1.0;vSpark=0.0;vDirection=vec2(1,0);
  if(maximum<0.22||(layer>0&&r<0.095)){
    gl_Position=vec4(2);gl_PointSize=1.0;return;
  }
  vec2 dir=r>0.001?p/r:vec2(1,0),tangent=vec2(-dir.y,dir.x);
  float angle=atan(p.y,p.x);
  float cluster=0.5+0.5*sin(angle*31.0+r*86.0);
  float spread=layer==0?0.0:(layer==1?0.27:0.66);
  vec2 pose=p*(1.0+outer*spread*pow(n,0.65));
  pose+=tangent*(m-0.5)*0.026*outer*float(layer);
  pose+=(vec2(n,m)-0.5)*(layer==0?0.008:0.006)*outer;
  float life=1.0;
  if(uTime>=0.0){
    // At 0.85 s every offset and gain is identity: the approved target frame.
    float grow=clamp(uTime/0.85,0.0,1.0);
    float scale=0.14+0.86*(1.0-pow(1.0-grow,2.0));
    float travel=max(uTime-0.85,0.0);
    pose*=scale;
    pose+=dir*travel*(0.025+0.13*outer)*(0.55+n);
    pose+=tangent*travel*travel*(m-0.5)*0.035;
    pose.y+=0.028*travel*travel*(0.6+m);
    // Stagger deaths, including the centre; neither RGB nor coverage survives.
    float death=1.80+0.75*m;
    life=smoothstep(0.0,0.13,uTime)*(1.0-smoothstep(death-0.60,death,uTime));
    // The same samples occupy less area during ignition. Compensate density
    // instead of letting their overlap bleach the smaller flower to white.
    life*=scale*scale;
    if(life<=0.0){gl_Position=vec4(2);gl_PointSize=1.0;return;}
  }
  vec2 world=(0.5+pose*1.02)*uViewport;
  gl_Position=vec4(world.x/uViewport.x*2.0-1.0,1.0-world.y/uViewport.y*2.0,0,1);
  vDirection=dir;
  float hot=step(0.48,n)*outer*cluster;
  float lengthPx=layer==1?(3.0+11.0*hot):(layer==2?1.5+4.0*n:2.8);
  float widthPx=layer==0?2.8:mix(1.0,2.3,m);
  gl_PointSize=max(lengthPx,widthPx)*uPixelRatio;
  vAspect=max(lengthPx/widthPx,1.0);
  vSpark=layer==1?0.92:0.60;
  // Preserve saturated petals; source light-gold outlines create hot white
  // highlights naturally when their radiance overlaps, without a white wash.
  vec3 colour=pow(source/max(maximum,0.0001),vec3(3.1));
  float bright=pow(maximum,2.2);
  float gain=layer==0?7.0:(layer==1?mix(1.0,7.0,hot):0.65);
  vEmission=colour*bright*gain*(layer==0?1.0:mix(0.45,1.0,m))*life;
  vCoverage=(layer==0?0.65:0.28)*life;
}`;
