import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLocalImpactSites, createSurfaceSample, findColliderCrossing, flowWeights, HeadFlowField,
  estimateBurstFrontRadius, pointInsideCollider, reflectAgainstHead, sampleHeadSurface,
} from '../src/HeadInteraction.ts';

function head(cx = 291, cy = 600, rotation = 0) {
  const rx = 140;
  const ry = 180;
  const points = Array.from({ length: 18 }, (_, index) => {
    const angle = index * Math.PI * 2 / 18;
    const x = Math.cos(angle) * rx;
    const y = Math.sin(angle) * ry;
    return {
      x: cx + x * Math.cos(rotation) - y * Math.sin(rotation),
      y: cy + x * Math.sin(rotation) + y * Math.cos(rotation),
    };
  });
  return { cx, cy, rx, ry, points };
}

function fieldAt(field, x, y) {
  const column = Math.min(field.columns - 1, Math.floor(x / field.width * field.columns));
  const row = Math.min(field.rows - 1, Math.floor(y / field.height * field.rows));
  const offset = (row * field.columns + column) * 4;
  return [...field.data.slice(offset, offset + 4)];
}

test('still head has no permanent contour halo without an actual impact', () => {
  const contour = head();
  const surface = sampleHeadSurface(291, 385, contour, createSurfaceSample());
  assert.equal(surface.inside, false);
  assert.ok(surface.normalY < -0.8);
  const mid = flowWeights(surface.localRadius * 0.15, surface.localRadius);
  const outer = flowWeights(surface.localRadius * 0.30, surface.localRadius);
  assert.ok(mid.mid > 0 && outer.mid === 0 && outer.outer > 0);
  const field = new HeadFlowField();
  field.resize(582, 1200);
  for (let frame = 0; frame < 60; frame += 1) field.update(contour, 0, 0, 1 / 60);
  assert.deepEqual(fieldAt(field, 291, 395), [128, 128, 128, 128]);
  assert.deepEqual(fieldAt(field, 10, 10).slice(0, 2), [128, 128]);
});

test('first contact follows the burst origin and creates three to five separate local sites', () => {
  const contour = head();
  const centered = createLocalImpactSites(contour, 291, 250, 8.4);
  assert.ok(centered.length >= 3 && centered.length <= 5);
  assert.equal(centered[0].primary, true);
  assert.ok(Math.abs(centered[0].x - contour.cx) < 24);
  assert.ok(centered[0].y < contour.cy);
  assert.ok(centered[0].strength > Math.max(...centered.slice(1).map((site) => site.strength)));
  assert.ok(centered.every((site) => site.radius <= 38));

  const offset = createLocalImpactSites(contour, 165, 300, 8.4);
  assert.ok(offset[0].x < centered[0].x - 20, 'main contact must move with an off-centre burst');
  assert.notEqual(offset[0].x, contour.cx, 'main contact is not fixed to screen/head centre');
});

test('slow and fast horizontal head motion push the local field, with bounded force', () => {
  const field = new HeadFlowField();
  field.resize(582, 1200);
  for (let frame = 0; frame < 25; frame += 1) field.update(head(291 + frame, 600), 90, 0, 1 / 60);
  const slow = fieldAt(field, 420, 600);
  for (let frame = 0; frame < 25; frame += 1) field.update(head(316 - frame * 2, 600), -1200, 0, 1 / 60);
  const fast = fieldAt(field, 420, 600);
  assert.notDeepEqual(slow, fast);
  assert.ok(field.data.every((value) => Number.isFinite(value) && value >= 0 && value <= 255));
});

test('turned head uses its actual rotated contour and local normal', () => {
  const contour = head(291, 600, 0.25);
  const surface = sampleHeadSurface(100, 420, contour, createSurfaceSample());
  assert.equal(surface.inside, false);
  assert.ok(surface.distance > 0 && Number.isFinite(surface.localRadius));
  assert.ok(surface.normalX * (surface.x - contour.cx) + surface.normalY * (surface.y - contour.cy) > 0);
});

test('falling particle sweeps through the forehead and reflects upward', () => {
  const contour = head();
  const crossing = findColliderCrossing(291, 350, 291, 470, contour, pointInsideCollider(291, 470, contour));
  assert.ok(crossing > 0 && crossing < 1);
  const contactY = 350 + (470 - 350) * crossing;
  const surface = sampleHeadSurface(291, contactY, contour, createSurfaceSample());
  const bounced = reflectAgainstHead(0, 650, 0, 0, surface.normalX, surface.normalY);
  assert.ok(bounced && bounced.y < 0);
});

test('grazing particle does not hard-collide; side hit changes horizontal direction', () => {
  const contour = head();
  assert.equal(findColliderCrossing(60, 340, 520, 340, contour, false), null);
  const crossing = findColliderCrossing(90, 600, 230, 600, contour, true);
  assert.ok(crossing > 0 && crossing < 1);
  const surface = sampleHeadSurface(90 + 140 * crossing, 600, contour, createSurfaceSample());
  const bounced = reflectAgainstHead(520, 0, 0, 0, surface.normalX, surface.normalY);
  assert.ok(bounced && bounced.x < 0);
});

test('head movement contributes to physical reflection; outgoing motion does not bounce', () => {
  const stationary = reflectAgainstHead(0, 650, 0, 0, 0, -1);
  const moving = reflectAgainstHead(0, 650, 0, -180, 0, -1);
  assert.ok(stationary && moving && moving.y < stationary.y);
  assert.equal(reflectAgainstHead(0, -400, 0, 0, 0, -1), null);
});

test('multiple bursts share a stable field without particle-object allocation', () => {
  const field = new HeadFlowField();
  field.resize(582, 1200);
  for (let frame = 0; frame < 120; frame += 1) field.update(head(291 + Math.sin(frame * 0.04) * 30), 120, 0, 1 / 60);
  assert.equal(field.data.length, field.columns * field.rows * 4);
  assert.ok(fieldAt(field, 420, 600).some((value) => value !== 128));
});

test('expanding burst produces a first-contact impulse against a stationary head', () => {
  const contour = head();
  const originX = contour.cx;
  const originY = 250;
  const surface = sampleHeadSurface(originX, originY, contour, createSurfaceSample());
  assert.ok(estimateBurstFrontRadius(0.20, 582) < surface.distance);
  assert.ok(estimateBurstFrontRadius(0.70, 582) >= surface.distance);

  const baseline = new HeadFlowField();
  baseline.resize(582, 1200);
  baseline.update(contour, 0, 0, 1 / 60);
  const before = fieldAt(baseline, surface.x, surface.y - 8);

  const impacted = new HeadFlowField();
  impacted.resize(582, 1200);
  impacted.addImpact(surface.x, surface.y, surface.normalX, surface.normalY, 58);
  impacted.update(contour, 0, 0, 1 / 60);
  const after = fieldAt(impacted, surface.x, surface.y - 8);
  assert.notDeepEqual(after, before);
  assert.ok(after[1] < before[1], 'stationary forehead contact should immediately push particles upward');

  for (let frame = 0; frame < 18; frame += 1) impacted.update(contour, 0, 0, 1 / 60);
  const sustainedCenter = fieldAt(impacted, surface.x, surface.y - 8);
  const sustainedSide = fieldAt(impacted, surface.x + 40, surface.y - 4);
  assert.ok(sustainedCenter[1] < 128, 'impact must keep rebounding while the head remains still');
  assert.notDeepEqual(sustainedSide.slice(0, 2), [128, 128], 'impact must spread across the forehead instead of forming a narrow cutout');
});

test('collision trail never rewinds toward the head while impact displacement settles', () => {
  const field = new HeadFlowField();
  field.resize(582, 1200);
  field.addImpact(291, 420, 0, -1, 80);
  let suppressedRecovery = false;
  for (let frame = 0; frame < 110; frame += 1) {
    field.update(null, 0, 0, 1 / 60);
    const packed = fieldAt(field, 291, 412);
    if (frame > 44 && packed[1] < 128 && packed[2] === 128 && packed[3] === 128) suppressedRecovery = true;
  }
  assert.equal(suppressedRecovery, true, 'feedback advection should stop instead of reversing during recovery');
});
