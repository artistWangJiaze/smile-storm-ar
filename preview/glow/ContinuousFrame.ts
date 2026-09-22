import { growthVertex } from './GrowthFrame';

// The accepted growth shader remains the only particle source for the entire
// lifetime. A monotone scale tail retains outward velocity through the peak;
// the radial dispersal accelerates while that carried velocity decays.
export const continuousVertex=growthVertex.replace(
 '    float scale=0.14+0.86*(1.0-pow(1.0-grow,2.0));',
 `    float scale=0.14+0.86*(1.0-pow(1.0-grow,2.0));
    if(uTime>0.65){
      float q=clamp((uTime-0.65)/0.20,0.0,1.0);
      float startScale=1.0-0.86*pow(0.20/0.85,2.0);
      float startSlope=2.0*0.86*0.20/(0.85*0.85);
      float endSlope=0.18;
      scale=(2.0*q*q*q-3.0*q*q+1.0)*startScale
        +(q*q*q-2.0*q*q+q)*0.20*startSlope
        +(-2.0*q*q*q+3.0*q*q)
        +(q*q*q-q*q)*0.20*endSlope;
      scale+=endSlope*0.20*(1.0-exp(-max(uTime-0.85,0.0)/0.20));
    }`
).replace(
 `    pose+=dir*travel*(0.025+0.13*outer)*(0.55+n);
    pose+=tangent*travel*travel*(m-0.5)*0.035;
    pose.y+=0.028*travel*travel*(0.6+m);`,
 `    float flight=travel*travel/(travel+0.18);
    float coreRelease=smoothstep(0.08,0.75,travel);
    float mobility=mix(outer,1.0,coreRelease);
    // Opening continues outside first; the centre then joins the same flow.
    // Different fixed particle speeds separate the sampled contours into dust.
    pose+=dir*flight*(0.025+0.30*mobility)*(0.35+1.35*n);
    pose+=tangent*flight*(m-0.5)*mobility*0.11;
    pose.y+=0.015*flight*flight*(0.6+m);`
).replace('  gl_PointSize=max(lengthPx,widthPx)*uPixelRatio;',`
  float fragmenting=smoothstep(1.0,1.9,uTime);
  lengthPx=mix(lengthPx,layer==0?2.0:4.0,fragmenting);
  widthPx=mix(widthPx,layer==0?1.15:0.95,fragmenting);
  gl_PointSize=max(lengthPx,widthPx)*uPixelRatio;`);
