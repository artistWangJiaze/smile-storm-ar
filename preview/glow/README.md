# Local-only, executable firework lighting study

Open `/preview/glow/` on the existing Vite development server. This directory
is not imported by the production entry point and has not been deployed.

## Target-frame study with optional motion and live camera background

`/preview/glow/target.html` opens the new fixed-pose study directly. It reuses
the ornament and existing HDR/bloom targets, with a separate deterministic
three-layer particle drawing shader (`TargetFrame.ts`). The centre stays intact;
the outer layers use dense, irregular short fragments and permit clipped hot
highlights. Random sampling avoids large-angle sine hashing, which produced
visibly uneven distributions during browser QA. One click compares the older
renderer at 1.35 seconds. The camera button above the canvas adds a live local
video background without advancing the approved pose. Particle coverage protects
colour locally; black-background RGB output is unchanged. Switching to black
stops camera tracks. No video is recorded or uploaded.
The top playback controls now exercise a deterministic 2.6-second visual cycle:
expansion to the approved pose at 0.85 s, outward dispersion with slight downward
drift, then staggered extinction. Ignition compensates for increased sample
density at small sizes. Every frame is redrawn without feedback, and both light
and coverage reach zero at expiry. Static comparison buttons pause playback;
the camera remains live while paused. This is analytic visual choreography,
NOT a production integration or collision simulation.
`capture-target.mjs` captures both actual WebGL outputs and checks the visible
toggle and shader errors. `capture-target-camera.mjs` checks the approved black
pixels, camera switching, track shutdown and permission denial using synthetic
video, not the user's webcam. `capture-target-motion.mjs` additionally checks
keyframes, zero start/end RGB, playback/pause/keyboard scrubbing, live background
updates and expiry restoration, and records actual canvas output to
`captures/target-motion.webm`. Golden-frame comparisons allow bounded subpixel
edge differences after shader recompilation (mean RGB error < 0.01 / 255;
changed pixels < 0.5%). Live-camera visual approval is still required.

## Minimal A/B colour-coverage study

Default B (`保色发光试验`) reuses the existing particles, feedback textures and
bloom. Independent lifetime-weighted sample coverage occupies the previously
unused accumulation alpha channel; the final pass composites saturated particle
colour over the camera locally, followed by additive-looking core/halo light.
No additional particle simulation, texture assets or full-screen darkener is used.
A (`上一版`) retains the prior light-only composite for a same-animation-time
comparison. Switching modes never restarts or advances the particle simulation.
The live camera still updates while particles are paused.

Coverage intentionally reduces some background colour channels *under particles*,
which is necessary for saturated colour over bright backgrounds. It does not grade
or darken the camera elsewhere. Both modes restore the original background at expiry.
This is a low-cost visual experiment, not approval of a TD-equivalent result.

- Original mandala images are sampled as particles; no generated image is used.
- Particle radiance and feedback are accumulated in RGBA16F render targets.
- Soft point kernels, motion-oriented short strokes and three bloom scales
  feed one opaque GPU output, including the selected background.
- Camera video is uploaded as a texture with mirrored object-fit cover cropping.
  sRGB decoding and encoding surround the linear-light emission composite. Its
  background-anchored highlight shoulder preserves the camera exactly at zero
  emission. A never lowers any background channel; B adds local particle coverage.
  No background dimmer is used.
- Local sharp spark peaks provide a separately controlled warm-white core;
  broad coloured radiance is bounded before the final highlight transform.
  Bright backgrounds necessarily reduce both visible halo contrast and saturation.
- Emission peaks at 1.12 seconds during expansion, with a sparse subset of
  motion-aligned hot spark fragments. Hue-preserving radiance compression and
  selective bloom limit broad-area bleaching.
- Particle lifetimes are staggered
  so the central ornament also disappears rather than remaining as a decal.
- `GlowPreviewSimulation.ts` differs from production only in its source-position
  choreography (before contact) and import paths/comments. Polygon collision,
  persistent reflected velocities and no-spring-back response are unchanged.
- This lighting page sends no head collider. Its optional camera is only a local
  background and is never uploaded. It does not claim camera/collision validation.
- Fixed logical canvas dimensions prevent window resizing from changing motion.

`capture.mjs` captures the running WebGL renderer, not a mockup. It checks shader
errors, HDR support and exact zero RGB on black after expiry. A synthetic local
video stream exercises camera upload, mirror/crop orientation, unchanged background
colours, positive light contribution and exact background restoration after expiry.
This is not a test of the user's live webcam or its auto exposure. Set `PLAYWRIGHT_MODULE`
to an existing Playwright module path; `RECORD=1` also captures WebM animation.
Captured PNGs/WebM are in `captures/` and use the same rendering code as the page.

Remaining approval: visual match to the supplied TouchDesigner reference,
especially brightness on a live camera background. Integration into the main
site and regression testing the new choreography with tracked heads are deferred
until the user approves this preview.
