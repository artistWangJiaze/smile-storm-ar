import { growthVertex } from './GrowthFrame';

// The accepted growth shader remains the only particle source for the entire
// lifetime. These terms are exactly zero at/before 0.85s: no resampling or
// switching to another pose at the handoff.
export const continuousVertex=growthVertex.replace(
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
