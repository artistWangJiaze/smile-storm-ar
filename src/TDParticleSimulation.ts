import type { HeadCollider } from './types';
import type { LocalImpactSite } from './HeadInteraction';

export const TD_GRID = 300;
export const TD_COUNT = TD_GRID * TD_GRID;
export const TD_STATE_STRIDE = 12;
const HEAD_CAP = 32;

// One record per source-image sample, retained between frames on the GPU:
// position.xy / velocity.xy, contact normal.xy / age / absolute time,
// previous position.xy / original contact point.xy.
export interface ParticleState {
  buffers: WebGLBuffer[];
  vaos: WebGLVertexArrayObject[];
  current: number;
  reset: boolean;
  generation: number;
  readback: WebGLBuffer;
  fence: WebGLSync | null;
  readbackGeneration: number;
  nextReadback: number;
  stats: ParticleStats;
}

export interface ParticleStats {
  active: number;
  bounced: number;
  firstContact: { x: number; y: number; nx: number; ny: number; time: number } | null;
}

interface SimulationInput {
  layer?: number;
  image: WebGLTexture;
  x: number;
  y: number;
  time: number;
  dt: number;
  dispersion: number;
  scale: number;
  seed: number;
  head: HeadCollider | null;
  headVx: number;
  headVy: number;
  sites: LocalImpactSite[];
  particleStep?: number;
}

export const collisionVertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 aState;
layout(location=1) in vec4 aContact;
layout(location=2) in vec4 aHistory;
uniform sampler2D uImage;
uniform int uParticleStep;
uniform vec2 uOrigin;
uniform float uTime, uDt, uScale, uDispersion, uSeed;
uniform bool uReset;
uniform int uHeadCount, uSiteCount;
uniform vec2 uHead[${HEAD_CAP}];
uniform vec2 uHeadCenter, uHeadVelocity;
uniform vec4 uHeadBounds;
uniform vec4 uSites[5];
out vec4 nextState;
out vec4 nextContact;
out vec4 nextHistory;

float hash(vec3 p) { return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }
float noise(vec3 p) {
  vec3 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}

vec2 sourcePosition(vec2 uv) {
  vec2 p=uv-0.5;
  vec3 n=vec3(p*5.0,uTime*0.1+uSeed);
  vec2 warp=vec2(noise(n),noise(n+vec3(17.1,9.7,3.1)))-0.5;
  p+=sign(warp)*pow(abs(warp)*2.0,vec2(3.28))*0.1625*0.075;
  float z=(noise(vec3(p*5.4,uTime/5.0+uSeed*0.2))-0.5)*0.6;
  p*=1.0+z*0.075;
  float shapeScale=mix(0.08,1.0,smoothstep(0.0,0.86,uDispersion));
  float burst=pow(clamp(uDispersion,0.0,1.0),1.1);
  vec2 base=p*390.0*uScale*shapeScale;
  float r=length(base);
  vec2 dir=r>0.001?base/r:vec2(1,0);
  vec2 tangent=vec2(-dir.y,dir.x);
  int particleId=gl_VertexID*max(uParticleStep,1);
  float x=float(particleId%${TD_GRID}), y=float(particleId/${TD_GRID});
  float seedA=hash(vec3(x,y,11)),seedB=hash(vec3(x,y,23)),seedC=hash(vec3(x,y,41));
  float stretch=noise(vec3(p*9.0,uTime*0.09+uSeed));
  float bend=noise(vec3(p*11.0+vec2(7.3,19.1),uTime*0.12+uSeed*1.3));
  float radial=burst*max(r-70.0*uScale*shapeScale,0.0)*(3.40+(stretch-0.5)*0.65);
  vec2 target=base+dir*radial+tangent*burst*(bend-0.5)*r*0.34;
  float diffuse=smoothstep(0.30,0.50,seedA)*smoothstep(55.0*uScale*shapeScale,160.0*uScale*shapeScale,r);
  target+=burst*diffuse*vec2(seedB-0.5,seedC-0.5)*(42.0*uScale+r*0.85);
  target.y-=burst*(14.0*uScale+r*0.055);
  return uOrigin+target;
}

float cross2(vec2 a,vec2 b) { return a.x*b.y-a.y*b.x; }
vec2 edgeNormal(vec2 a,vec2 b) {
  vec2 n=normalize(vec2(b.y-a.y,a.x-b.x)+vec2(0.000001));
  return dot(n,(a+b)*0.5-uHeadCenter)<0.0?-n:n;
}

void main() {
  int particleId=gl_VertexID*max(uParticleStep,1);
  vec2 uv=(vec2(float(particleId%${TD_GRID}),float(particleId/${TD_GRID}))+0.5)/float(${TD_GRID});
  vec4 source=texture(uImage,vec2(uv.x,1.0-uv.y));
  if(source.a<0.01||dot(source.rgb,vec3(0.2126,0.7152,0.0722))<0.238) {
    nextState=vec4(-10000, -10000, 0, 0); nextContact=vec4(0,0,-2,0); nextHistory=vec4(-10000); return;
  }
  vec2 target=sourcePosition(uv);
  vec2 previous=uReset?target:aState.xy;
  bool bounced=!uReset&&aContact.z>=0.0;
  vec2 velocity=bounced?aState.zw*exp(-1.15*uDt):(target-previous)/max(uDt,0.00001);
  vec2 position=bounced?previous+velocity*uDt:target;
  nextContact=uReset?vec4(0,0,-1,0):aContact;
  nextHistory=uReset?vec4(previous,0,0):vec4(previous,aHistory.zw);
  if(bounced) nextContact.z+=uDt;

  // Test the path of this very particle, including crossings between frames.
  // A bounding check avoids polygon work for the majority of the image.
  vec2 lo=min(previous,position),hi=max(previous,position);
  bool near=uHeadCount>=3&&hi.x>=uHeadBounds.x&&hi.y>=uHeadBounds.y&&lo.x<=uHeadBounds.z&&lo.y<=uHeadBounds.w;
  if(near) {
    vec2 step=position-previous;
    float firstT=2.0,nearest=1.0e20;
    vec2 normal=vec2(0,-1),contact=position,nearestPoint=position,nearestNormal=normal;
    bool inside=false;
    for(int i=0;i<${HEAD_CAP};i++) {
      if(i>=uHeadCount) break;
      vec2 a=uHead[i],b=uHead[(i+1)%uHeadCount],edge=b-a;
      float along=clamp(dot(position-a,edge)/max(dot(edge,edge),0.0001),0.0,1.0);
      vec2 q=a+edge*along;
      float d=dot(position-q,position-q);
      if(d<nearest) { nearest=d; nearestPoint=q; nearestNormal=edgeNormal(a,b); }
      if((a.y>position.y)!=(b.y>position.y)) {
        if(position.x<(b.x-a.x)*(position.y-a.y)/(b.y-a.y)+a.x) inside=!inside;
      }
      float denom=cross2(step,edge);
      if(abs(denom)>0.00001) {
        float t=cross2(a-previous,edge)/denom, s=cross2(a-previous,step)/denom;
        vec2 n=edgeNormal(a,b);
        if(t>=0.0&&t<=1.0&&s>=0.0&&s<=1.0&&t<firstT&&dot(step,n)<0.0) {
          firstT=t; contact=previous+step*t; normal=n;
        }
      }
    }
    if(firstT<=1.0||inside) {
      if(firstT>1.0) { contact=nearestPoint; normal=nearestNormal; firstT=1.0; }
      vec2 headVelocity=clamp(uHeadVelocity,vec2(-480),vec2(480));
      vec2 relative=velocity-headVelocity;
      float inward=dot(relative,normal);
      if(!bounced) {
        float boost=0.0;
        for(int i=0;i<5;i++) {
          if(i>=uSiteCount) break;
          float k=max(0.0,1.0-distance(contact,uSites[i].xy)/uSites[i].z);
          boost=max(boost,k*k*uSites[i].w);
        }
        float random=hash(vec3(uv*float(${TD_GRID}),uSeed));
        float restitution=0.58+0.16*random+boost*0.14;
        velocity=relative-(1.0+restitution)*min(inward,0.0)*normal+headVelocity*0.5;
        float outward=max(105.0+boost*95.0,min(680.0,-inward*restitution));
        velocity+=normal*max(0.0,outward-dot(velocity,normal));
        vec2 tangent=vec2(-normal.y,normal.x);
        float side=dot(contact-uOrigin,tangent)>=0.0?1.0:-1.0;
        velocity+=tangent*side*(25.0+random*70.0+boost*45.0);
        velocity*=min(1.0,900.0/max(length(velocity),1.0));
        nextContact=vec4(normal,0,uTime);
        nextHistory.zw=contact;
      } else {
        // Separate a later overlap without adding a second elastic impulse.
        velocity-=normal*min(0.0,dot(velocity-headVelocity,normal));
      }
      position=contact+normal*1.6+velocity*uDt*(1.0-firstT);
      // A short segment starts at contact; no long line across the face.
      nextHistory.xy=contact+normal*1.6;
    }
  }
  nextState=vec4(position,velocity);
}`;

export class TDParticleSimulation {
  private readonly program: WebGLProgram;
  private readonly feedback: WebGLTransformFeedback;
  private readonly uniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly headData = new Float32Array(HEAD_CAP * 2);
  private readonly siteData = new Float32Array(5 * 4);
  private readonly readbackData = new Float32Array(TD_COUNT * TD_STATE_STRIDE);

  constructor(private readonly gl: WebGL2RenderingContext, vertexSource = collisionVertex) {
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compile(gl, gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; out vec4 c; void main(){c=vec4(0); }');
    const program = gl.createProgram();
    const feedback = gl.createTransformFeedback();
    if (!program || !feedback) throw new Error('Unable to allocate particle simulation');
    gl.attachShader(program, vs); gl.attachShader(program, fs);
    gl.transformFeedbackVaryings(program, ['nextState', 'nextContact', 'nextHistory'], gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(program); gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Particle simulation link failed');
    this.program = program; this.feedback = feedback;
    for (const name of ['uLayer','uParticleStep','uImage','uOrigin','uTime','uDt','uScale','uDispersion','uSeed','uReset','uHeadCount','uSiteCount','uHead[0]','uHeadCenter','uHeadVelocity','uHeadBounds','uSites[0]']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
  }

  createState(): ParticleState {
    const gl = this.gl;
    const buffers: WebGLBuffer[] = [], vaos: WebGLVertexArrayObject[] = [];
    for (let i = 0; i < 2; i += 1) {
      const buffer = gl.createBuffer()!, vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, TD_COUNT * TD_STATE_STRIDE * 4, gl.DYNAMIC_COPY);
      for (let attribute = 0; attribute < 3; attribute += 1) {
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(attribute, 4, gl.FLOAT, false, TD_STATE_STRIDE * 4, attribute * 16);
      }
      buffers.push(buffer); vaos.push(vao);
    }
    const readback = gl.createBuffer()!;
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, readback);
    gl.bufferData(gl.COPY_WRITE_BUFFER, TD_COUNT * TD_STATE_STRIDE * 4, gl.STREAM_READ);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null); gl.bindBuffer(gl.ARRAY_BUFFER, null); gl.bindVertexArray(null);
    return { buffers, vaos, current: 0, reset: true, generation: 0, readback, fence: null,
      readbackGeneration: 0, nextReadback: 0, stats: { active: 0, bounced: 0, firstContact: null } };
  }

  reset(state: ParticleState) {
    state.reset = true; state.generation += 1; state.nextReadback = 0;
    state.stats = { active: 0, bounced: 0, firstContact: null };
    if (state.fence) this.gl.deleteSync(state.fence);
    state.fence = null;
  }

  step(state: ParticleState, input: SimulationInput) {
    const gl = this.gl, u = this.uniforms;
    gl.useProgram(this.program);
    gl.uniform1i(u.uLayer, input.layer ?? 0);
    const particleStep=Math.max(1,Math.floor(input.particleStep ?? 1));
    gl.uniform1i(u.uParticleStep,particleStep);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input.image);
    gl.uniform1i(u.uImage, 0); gl.uniform2f(u.uOrigin, input.x, input.y);
    gl.uniform1f(u.uTime, input.time); gl.uniform1f(u.uDt, input.dt);
    gl.uniform1f(u.uScale, input.scale); gl.uniform1f(u.uDispersion, input.dispersion);
    gl.uniform1f(u.uSeed, input.seed); gl.uniform1i(u.uReset, state.reset ? 1 : 0);
    const head = input.head;
    let count = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (head) {
      count = Math.min(HEAD_CAP, head.points?.length || HEAD_CAP);
      for (let i = 0; i < count; i += 1) {
        // Keep the complete contour when a tracker supplies more vertices
        // than the shader budget; never truncate one side of the head.
        const point = head.points?.[Math.floor(i * head.points.length / count)];
        const angle = i * Math.PI * 2 / count, rotation = head.rotation ?? 0;
        const ex = Math.cos(angle) * head.rx, ey = Math.sin(angle) * head.ry;
        const x = point?.x ?? head.cx + ex * Math.cos(rotation) - ey * Math.sin(rotation);
        const y = point?.y ?? head.cy + ex * Math.sin(rotation) + ey * Math.cos(rotation);
        this.headData[i * 2] = x; this.headData[i * 2 + 1] = y;
        minX = Math.min(minX,x); minY = Math.min(minY,y); maxX = Math.max(maxX,x); maxY = Math.max(maxY,y);
      }
      gl.uniform2fv(u['uHead[0]'], this.headData);
      gl.uniform2f(u.uHeadCenter,head.cx,head.cy);
      gl.uniform4f(u.uHeadBounds,minX,minY,maxX,maxY);
    }
    gl.uniform1i(u.uHeadCount,count);
    gl.uniform2f(u.uHeadVelocity,input.headVx,input.headVy);
    const siteCount = Math.min(5,input.sites.length);
    for(let i=0;i<siteCount;i++) {
      const s=input.sites[i]; this.siteData.set([s.x,s.y,s.radius,s.strength],i*4);
    }
    gl.uniform1i(u.uSiteCount,siteCount); gl.uniform4fv(u['uSites[0]'],this.siteData);
    gl.bindVertexArray(state.vaos[state.current]);
    const next = 1-state.current;
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,this.feedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,state.buffers[next]);
    gl.enable(gl.RASTERIZER_DISCARD); gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS,0,Math.ceil(TD_COUNT/particleStep));
    gl.endTransformFeedback(); gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,null); gl.bindVertexArray(null);
    state.current=next; state.reset=false;
  }

  // Copy asynchronously so the face-tracking/render loop does not wait for
  // GPU completion. Counts come from actual contact records, not region count.
  updateStats(state: ParticleState, time: number) {
    // Newly allocated buffers contain zeros, not contact records.
    if (state.reset) return;
    const gl=this.gl;
    if(state.fence) {
      const status=gl.clientWaitSync(state.fence,0,0);
      if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED) {
        gl.bindBuffer(gl.COPY_READ_BUFFER,state.readback);
        gl.getBufferSubData(gl.COPY_READ_BUFFER,0,this.readbackData);
        gl.bindBuffer(gl.COPY_READ_BUFFER,null);
        gl.deleteSync(state.fence); state.fence=null;
        if(state.readbackGeneration===state.generation) state.stats=summarize(this.readbackData);
      }
    }
    if(!state.fence&&time>=state.nextReadback) {
      gl.bindBuffer(gl.COPY_READ_BUFFER,state.buffers[state.current]);
      gl.bindBuffer(gl.COPY_WRITE_BUFFER,state.readback);
      gl.copyBufferSubData(gl.COPY_READ_BUFFER,gl.COPY_WRITE_BUFFER,0,0,this.readbackData.byteLength);
      gl.bindBuffer(gl.COPY_READ_BUFFER,null); gl.bindBuffer(gl.COPY_WRITE_BUFFER,null);
      state.fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
      state.readbackGeneration=state.generation; state.nextReadback=time+0.16; gl.flush();
    }
  }

  snapshot(state: ParticleState) {
    const data=new Float32Array(TD_COUNT*TD_STATE_STRIDE);
    this.gl.bindBuffer(this.gl.COPY_READ_BUFFER,state.buffers[state.current]);
    this.gl.getBufferSubData(this.gl.COPY_READ_BUFFER,0,data);
    this.gl.bindBuffer(this.gl.COPY_READ_BUFFER,null);
    return data;
  }

  disposeState(state: ParticleState) {
    for(const buffer of state.buffers) this.gl.deleteBuffer(buffer);
    for(const vao of state.vaos) this.gl.deleteVertexArray(vao);
    this.gl.deleteBuffer(state.readback);
    if(state.fence) this.gl.deleteSync(state.fence);
  }
  dispose() { this.gl.deleteProgram(this.program); this.gl.deleteTransformFeedback(this.feedback); }
}

function summarize(data: Float32Array): ParticleStats {
  let active=0,bounced=0,firstContact:ParticleStats['firstContact']=null;
  for(let i=0;i<data.length;i+=TD_STATE_STRIDE) {
    if(data[i+6]<-1.5) continue;
    if(data[i+6]<2.2) active+=1;
    if(data[i+6]<0) continue;
    bounced+=1;
    if(!firstContact||data[i+7]<firstContact.time) {
      firstContact={x:data[i+10],y:data[i+11],nx:data[i+4],ny:data[i+5],time:data[i+7]};
    }
  }
  return {active,bounced,firstContact};
}

function compile(gl:WebGL2RenderingContext,type:number,source:string) {
  const shader=gl.createShader(type)!; gl.shaderSource(shader,source); gl.compileShader(shader);
  if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)??'Particle shader failed');
  return shader;
}
