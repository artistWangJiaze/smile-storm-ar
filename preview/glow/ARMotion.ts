import { continuousVertex } from './ContinuousFrame';
import { collisionVertex } from '../../src/TDParticleSimulation';

// Use precisely the approved analytic trajectory as the collision solver's
// target. Once contacted, the existing solver retains position and momentum.
const body = continuousVertex.slice(continuousVertex.indexOf('  int layer=uLayer;'), continuousVertex.indexOf('  vec2 world='))
 .replace(/  vEmission=vec3\(0\);[^\n]+\n/, '')
 .replaceAll('gl_Position=vec4(2);gl_PointSize=1.0;return;', 'return vec2(-10000);');
const hash = continuousVertex.slice(continuousVertex.indexOf('float hash('), continuousVertex.indexOf('void main()'));
export const arCollisionVertex = collisionVertex
 .replace('uniform sampler2D uImage;', 'uniform sampler2D uImage; uniform int uLayer;')
 .replace(/vec2 sourcePosition\(vec2 uv\) \{[\s\S]*?\n\}\n\nfloat cross2/, `${hash}\nvec2 sourcePosition(vec2 unused) {\n${body}\nreturn uOrigin+pose*1.02*uScale;\n}\n\nfloat cross2`)
 // Eligibility is determined inside the approved trajectory, including the
 // polar sampling of the two spark layers, not the old square-grid mask.
 .replace('if(source.a<0.01||dot(source.rgb,vec3(0.2126,0.7152,0.0722))<0.238)', 'if(sourcePosition(uv).x < -9000.0)')
 .replace('vec2 previous=uReset?target:aState.xy;', 'vec2 previous=(uReset||aContact.z < -1.5)?target:aState.xy;')
 .replace('return uOrigin+pose*1.02*uScale;', 'float c=cos(uDispersion),s=sin(uDispersion); pose=mat2(c,s,-s,c)*pose; return uOrigin+pose*1.02*uScale;')
 // First impact must visibly leave the dense bloom. Apply an impulse only at
 // contact; subsequent frames keep the existing damped ballistic trajectory.
 .replace('105.0+boost*95.0', '280.0+random*110.0+boost*65.0')
 .replace('25.0+random*70.0+boost*45.0', '95.0+random*150.0+boost*35.0');

export const arRenderVertex = continuousVertex
 .replace('uniform vec2 uViewport;', 'layout(location=0) in vec4 aState; layout(location=1) in vec4 aContact; uniform vec2 uViewport;')
 .replace('vec2 world=(0.5+pose*1.02)*uViewport;', 'vec2 world=aState.xy*uPixelRatio;')
 .replace('  vDirection=dir;', '  vDirection=aContact.z>=0.0?normalize(aState.zw+vec2(0.00001)):dir;')
 // Contact releases fine sparks instead of piling the dense ornament's full
 // radiance along the contour. Uncontacted flower rendering is untouched.
 .replace('  vCoverage=(layer==0?0.65:0.28)*life;', `
  vCoverage=(layer==0?0.65:0.28)*life;
  if(aContact.z>=0.0){
    // Match the accepted renderer's contact lifetime and small velocity-aligned
    // sparks. Do not carry the intact ornament's 7x HDR gain into the collision.
    float contactFade=1.0-smoothstep(1.6,2.2,aContact.z);
    float firstImpact=1.0-smoothstep(0.12,0.40,aContact.z);
    vEmission=pow(source,vec3(2.2))*mix(0.714,1.8,firstImpact)*life*contactFade;
    vCoverage=mix(0.18,0.5,firstImpact)*life*contactFade;
    vSpark=0.35*firstImpact;
    gl_PointSize=clamp(length(aState.zw)*0.024*uPixelRatio,2.4,12.0);
    vAspect=max(1.0,gl_PointSize/(1.6*uPixelRatio));
  }`);
