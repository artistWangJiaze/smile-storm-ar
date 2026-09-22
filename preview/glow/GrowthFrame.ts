import { targetVertex } from './TargetFrame';

// Isolated 0–25-frame study. The original scale envelope stays in place;
// opening changes relative ring spacing and releases the existing sparks.
export const growthVertex=targetVertex
 .replace('  float life=1.0;', `
  float growth=clamp(uTime/0.85,0.0,1.0);
  float opening=smoothstep(0.22,0.94,growth);
  float ring=smoothstep(0.055,0.40,r);
  float ringOpening=pow(opening,mix(0.75,1.30,ring));
  float radialOpen=mix(mix(0.94,0.56,ring),1.0,ringOpening);
  // Flower core stays relatively stable; outer motifs open much farther.
  // Start with the ornament itself, then release the same sampled particles.
  vec2 resting=p*radialOpen;
  float release=smoothstep(0.24,1.0,growth);
  pose=mix(resting,pose,layer==0?opening:release);
  float life=1.0;`)
 .replace('    life*=scale*scale;', `
    life*=scale*scale;
    life*=layer==0?mix(0.64,1.0,opening):mix(0.035,1.0,release);`)
 .replace('  gl_PointSize=max(lengthPx,widthPx)*uPixelRatio;', `
  lengthPx*=layer==0?1.0:mix(0.25,1.0,release);
  gl_PointSize=max(lengthPx,widthPx)*uPixelRatio;`);
