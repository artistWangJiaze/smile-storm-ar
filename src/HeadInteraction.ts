import type { HeadCollider } from './types';

export interface SurfaceSample {
  x: number;
  y: number;
  normalX: number;
  normalY: number;
  distance: number;
  localRadius: number;
  inside: boolean;
}

export interface LocalImpactSite {
  x: number;
  y: number;
  normalX: number;
  normalY: number;
  radius: number;
  strength: number;
  primary: boolean;
}

export function createSurfaceSample(): SurfaceSample {
  return { x: 0, y: 0, normalX: 0, normalY: -1, distance: Infinity, localRadius: 1, inside: false };
}

export function nearHeadBounds(x: number, y: number, head: HeadCollider, margin = 0.42) {
  return Math.abs(x - head.cx) <= head.rx * (1 + margin) + 12
    && Math.abs(y - head.cy) <= head.ry * (1 + margin) + 12;
}

// The contour is already the smoothed 18-point MediaPipe head outline. Both
// the CPU collision particles and the visual flow field query this surface.
export function sampleHeadSurface(x: number, y: number, head: HeadCollider, out: SurfaceSample): SurfaceSample {
  const points = head.points;
  if (points && points.length >= 3) {
    let nearestSquared = Infinity;
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      const edgeX = b.x - a.x;
      const edgeY = b.y - a.y;
      const t = clamp(((x - a.x) * edgeX + (y - a.y) * edgeY) / Math.max(0.0001, edgeX * edgeX + edgeY * edgeY), 0, 1);
      const surfaceX = a.x + edgeX * t;
      const surfaceY = a.y + edgeY * t;
      const dx = x - surfaceX;
      const dy = y - surfaceY;
      const squared = dx * dx + dy * dy;
      if (squared < nearestSquared) {
        let normalX = edgeY;
        let normalY = -edgeX;
        const midpointX = (a.x + b.x) * 0.5 - head.cx;
        const midpointY = (a.y + b.y) * 0.5 - head.cy;
        if (normalX * midpointX + normalY * midpointY < 0) { normalX = -normalX; normalY = -normalY; }
        const length = Math.hypot(normalX, normalY) || 1;
        out.x = surfaceX;
        out.y = surfaceY;
        out.normalX = normalX / length;
        out.normalY = normalY / length;
        nearestSquared = squared;
      }
      // Keep the inside test in this one contour traversal.
      const prior = points[previous];
      if ((prior.y > y) !== (a.y > y)
        && x < ((a.x - prior.x) * (y - prior.y)) / (a.y - prior.y || 0.0001) + prior.x) inside = !inside;
    }
    out.distance = Math.sqrt(nearestSquared);
    out.localRadius = Math.max(36, Math.hypot(out.x - head.cx, out.y - head.cy));
    out.inside = inside;
    return out;
  }

  const dx = x - head.cx;
  const dy = y - head.cy;
  const rx = Math.max(1, head.rx);
  const ry = Math.max(1, head.ry);
  const implicit = Math.sqrt(dx * dx / (rx * rx) + dy * dy / (ry * ry)) || 0.00001;
  out.x = head.cx + dx / implicit;
  out.y = head.cy + dy / implicit;
  let normalX = (out.x - head.cx) / (rx * rx);
  let normalY = (out.y - head.cy) / (ry * ry);
  const length = Math.hypot(normalX, normalY) || 1;
  out.normalX = normalX / length;
  out.normalY = normalY / length;
  out.distance = Math.hypot(x - out.x, y - out.y);
  out.localRadius = Math.max(36, Math.hypot(out.x - head.cx, out.y - head.cy));
  out.inside = implicit < 1;
  return out;
}

export function pointInsideCollider(x: number, y: number, head: HeadCollider) {
  const points = head.points;
  if (points && points.length >= 3) {
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
      const current = points[index];
      const prior = points[previous];
      if ((current.y > y) !== (prior.y > y)
        && x < (prior.x - current.x) * (y - current.y) / (prior.y - current.y || 0.0001) + current.x) inside = !inside;
    }
    return inside;
  }
  const dx = x - head.cx;
  const dy = y - head.cy;
  return dx * dx / Math.max(1, head.rx * head.rx) + dy * dy / Math.max(1, head.ry * head.ry) < 1;
}

export function findColliderCrossing(
  previousX: number, previousY: number, currentX: number, currentY: number,
  head: HeadCollider, currentInside: boolean,
) {
  if (currentInside) {
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const mid = (low + high) * 0.5;
      if (pointInsideCollider(previousX + (currentX - previousX) * mid, previousY + (currentY - previousY) * mid, head)) high = mid;
      else low = mid;
    }
    return high;
  }
  if (head.points && head.points.length >= 3) {
    let earliest = Infinity;
    const points = head.points;
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      const t = segmentIntersectionT(previousX, previousY, currentX, currentY, a.x, a.y, b.x, b.y);
      if (t !== null && t > 0.0001 && t < earliest) earliest = t;
    }
    return Number.isFinite(earliest) ? earliest : null;
  }
  const dx = currentX - previousX;
  const dy = currentY - previousY;
  const ox = previousX - head.cx;
  const oy = previousY - head.cy;
  const rx = Math.max(1, head.rx);
  const ry = Math.max(1, head.ry);
  const a = dx * dx / (rx * rx) + dy * dy / (ry * ry);
  const b = 2 * (ox * dx / (rx * rx) + oy * dy / (ry * ry));
  const c = ox * ox / (rx * rx) + oy * oy / (ry * ry) - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0 || a < 0.000001) return null;
  const root = Math.sqrt(discriminant);
  const t0 = (-b - root) / (2 * a);
  const t1 = (-b + root) / (2 * a);
  return t0 > 0.0001 && t0 <= 1 ? t0 : t1 > 0.0001 && t1 <= 1 ? t1 : null;
}

export function reflectAgainstHead(
  velocityX: number, velocityY: number,
  headVelocityX: number, headVelocityY: number,
  normalX: number, normalY: number,
  restitution = 0.48, headTransfer = 0.46,
) {
  const relativeX = velocityX - headVelocityX;
  const relativeY = velocityY - headVelocityY;
  const normalSpeed = relativeX * normalX + relativeY * normalY;
  if (normalSpeed >= 0) return null;
  return {
    x: relativeX - (1 + restitution) * normalSpeed * normalX + headVelocityX * headTransfer,
    y: relativeY - (1 + restitution) * normalSpeed * normalY + headVelocityY * headTransfer,
  };
}

export function flowWeights(distance: number, radius: number) {
  const midRadius = radius * 0.22;
  const outerRadius = radius * 0.40;
  if (distance >= outerRadius) return { mid: 0, outer: 0 };
  const midK = clamp(1 - distance / midRadius, 0, 1);
  const outerK = clamp(1 - distance / outerRadius, 0, 1);
  return { mid: midK * midK * (3 - 2 * midK), outer: 0.28 * outerK * outerK * (3 - 2 * outerK) };
}

// Approximate the visible leading edge of the imported 300x300 burst. This
// follows the same dispersion value used by the point shader, so a stationary
// head can receive an impact as soon as the expanding image reaches it.
export function estimateBurstFrontRadius(dispersion: number, viewportMin: number) {
  const progress = clamp(dispersion, 0, 1);
  return Math.max(0, viewportMin) * (0.04 + progress * 0.42 + progress * progress * 0.30) * 0.86;
}

// Split one broad burst/forehead intersection into a handful of separate
// contact patches. The first site is always the true nearest point to the
// current burst origin; the other sites are irregularly selected from seven
// contour zones around it. This keeps the main notch attached to the actual
// first contact while avoiding a continuous, hat-brim-shaped ring.
export function createLocalImpactSites(
  head: HeadCollider, sourceX: number, sourceY: number, seed = 0,
): LocalImpactSite[] {
  const primarySample = sampleHeadSurface(sourceX, sourceY, head, createSurfaceSample());
  const count = 3 + Math.floor(hashUnit(seed, 1) * 3);
  const direction = hashUnit(seed, 2) < 0.5 ? -1 : 1;
  const zoneOrder = [0, direction * 2, direction * -2, direction, direction * -3, direction * -1, direction * 3];
  const spacing = clamp(head.rx * 0.22, 24, 44);
  const sites: LocalImpactSite[] = [];

  for (let index = 0; index < count; index += 1) {
    const zone = zoneOrder[index];
    const contour = sampleContourOffset(head, sourceX, sourceY, zone * spacing, primarySample);
    const variation = hashUnit(seed, 10 + index);
    const primary = zone === 0;
    sites.push({
      x: contour.x,
      y: contour.y,
      normalX: contour.normalX,
      normalY: contour.normalY,
      radius: primary
        ? clamp(head.rx * 0.20, 25, 38)
        : clamp(head.rx * (0.135 + variation * 0.025), 20, 31),
      strength: primary ? 1.38 : 0.68 + variation * 0.26 - Math.abs(zone) * 0.025,
      primary,
    });
  }
  return sites;
}

// A small, persistent screen-space velocity field makes *all* imported TD
// particles bend together without simulating 90,000 JavaScript objects.
// RG stores displacement; BA stores frame displacement for trail advection.
// Signed square encoding gives
// subpixel precision near zero while still representing an entire face width.
export class HeadFlowField {
  width = 1;
  height = 1;
  columns = 2;
  rows = 2;
  data = new Uint8Array(16);
  private dx = new Float32Array(4);
  private dy = new Float32Array(4);
  private vx = new Float32Array(4);
  private vy = new Float32Array(4);
  private previousTotalX = new Float32Array(4);
  private previousTotalY = new Float32Array(4);
  private trailLockNormalX = new Float32Array(4);
  private trailLockNormalY = new Float32Array(4);
  private trailLockLife = new Float32Array(4);
  private trailNoReturn = new Uint8Array(4);
  private readonly sample = createSurfaceSample();
  private readonly impactActive = new Uint8Array(8);
  private readonly impactX = new Float32Array(8);
  private readonly impactY = new Float32Array(8);
  private readonly impactNormalX = new Float32Array(8);
  private readonly impactNormalY = new Float32Array(8);
  private readonly impactRadius = new Float32Array(8);
  private readonly impactStrength = new Float32Array(8);
  private readonly impactLife = new Float32Array(8);
  private impactCursor = 0;

  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.columns = Math.ceil(this.width / 10);
    this.rows = Math.ceil(this.height / 10);
    const count = this.columns * this.rows;
    this.dx = new Float32Array(count);
    this.dy = new Float32Array(count);
    this.vx = new Float32Array(count);
    this.vy = new Float32Array(count);
    this.previousTotalX = new Float32Array(count);
    this.previousTotalY = new Float32Array(count);
    this.trailLockNormalX = new Float32Array(count);
    this.trailLockNormalY = new Float32Array(count);
    this.trailLockLife = new Float32Array(count);
    this.trailNoReturn = new Uint8Array(count);
    this.data = new Uint8Array(count * 4);
    this.data.fill(128);
    this.impactActive.fill(0);
  }

  reset() {
    this.dx.fill(0);
    this.dy.fill(0);
    this.vx.fill(0);
    this.vy.fill(0);
    this.previousTotalX.fill(0);
    this.previousTotalY.fill(0);
    this.trailLockNormalX.fill(0);
    this.trailLockNormalY.fill(0);
    this.trailLockLife.fill(0);
    this.trailNoReturn.fill(0);
    this.impactActive.fill(0);
    this.impactLife.fill(0);
    this.data.fill(128);
  }

  // A one-shot impulse for the first frame in which a burst reaches the head.
  // It is intentionally independent of head velocity: the expanding firework
  // has its own incoming momentum even when the user keeps perfectly still.
  addImpact(x: number, y: number, normalX: number, normalY: number, radius: number, strength = 1) {
    const safeRadius = Math.max(24, radius);
    const pulseIndex = this.impactCursor;
    this.impactCursor = (this.impactCursor + 1) % this.impactActive.length;
    this.impactActive[pulseIndex] = 1;
    this.impactX[pulseIndex] = x;
    this.impactY[pulseIndex] = y;
    this.impactNormalX[pulseIndex] = normalX;
    this.impactNormalY[pulseIndex] = normalY;
    this.impactRadius[pulseIndex] = safeRadius;
    this.impactStrength[pulseIndex] = clamp(strength, 0, 2.0);
    this.impactLife[pulseIndex] = 0.68;
    const minColumn = Math.max(0, Math.floor((x - safeRadius) / this.width * this.columns));
    const maxColumn = Math.min(this.columns - 1, Math.ceil((x + safeRadius) / this.width * this.columns));
    const minRow = Math.max(0, Math.floor((y - safeRadius) / this.height * this.rows));
    const maxRow = Math.min(this.rows - 1, Math.ceil((y + safeRadius) / this.height * this.rows));
    const tangentX = -normalY;
    const tangentY = normalX;

    for (let row = minRow; row <= maxRow; row += 1) {
      const cellY = (row + 0.5) * this.height / this.rows;
      for (let column = minColumn; column <= maxColumn; column += 1) {
        const cellX = (column + 0.5) * this.width / this.columns;
        const offsetX = cellX - x;
        const offsetY = cellY - y;
        const tangentOffset = offsetX * tangentX + offsetY * tangentY;
        const normalOffset = offsetX * normalX + offsetY * normalY;
        // Each patch is narrow and shallow. Several separated patches make the
        // mass break locally instead of tracing the whole forehead contour.
        const normalizedDistance = Math.hypot(tangentOffset / safeRadius, normalOffset / (safeRadius * 0.72));
        if (normalizedDistance >= 1) continue;
        const linear = 1 - normalizedDistance;
        const falloff = linear * linear * (3 - 2 * linear) * clamp(strength, 0, 2.0);
        const split = tangentOffset === 0
          ? (Math.sin(cellX * 0.071 + cellY * 0.043) >= 0 ? 1 : -1)
          : Math.sign(tangentOffset);
        const index = row * this.columns + column;
        this.trailLockNormalX[index] = normalX;
        this.trailLockNormalY[index] = normalY;
        this.trailLockLife[index] = Math.max(this.trailLockLife[index], 0.52);
        this.trailNoReturn[index] = 1;
        const normalImpulse = 1040 * falloff;
        const lateralImpulse = 560 * falloff * split;
        this.vx[index] += normalX * normalImpulse + tangentX * lateralImpulse;
        this.vy[index] += normalY * normalImpulse + tangentY * lateralImpulse;
        // Apply a small displacement immediately; velocity then carries the
        // rebound through following frames and into the feedback trail.
        this.dx[index] += normalX * 31 * falloff + tangentX * lateralImpulse * 0.026;
        this.dy[index] += normalY * 31 * falloff + tangentY * lateralImpulse * 0.026;
      }
    }
  }

  update(head: HeadCollider | null, headVx: number, headVy: number, dt: number) {
    const safeDt = Math.min(0.034, Math.max(0, dt));
    const maxHeadVx = clamp(headVx, -480, 480);
    const maxHeadVy = clamp(headVy, -480, 480);
    const sample = this.sample;
    // Critically damp the recovery so the field settles instead of behaving
    // like a spring and producing a second visible bounce toward the head.
    const velocityDamping = Math.exp(-9.2 * safeDt);
    for (let impact = 0; impact < this.impactActive.length; impact += 1) {
      if (!this.impactActive[impact]) continue;
      this.impactLife[impact] -= safeDt;
      if (this.impactLife[impact] <= 0) this.impactActive[impact] = 0;
    }
    for (let row = 0; row < this.rows; row += 1) {
      const y = (row + 0.5) * this.height / this.rows;
      for (let column = 0; column < this.columns; column += 1) {
        const x = (column + 0.5) * this.width / this.columns;
        const index = row * this.columns + column;
        let forceX = 0;
        let forceY = 0;
        if (head && nearHeadBounds(x, y, head)) {
          sampleHeadSurface(x, y, head, sample);
          if (!sample.inside) {
            const { mid, outer } = flowWeights(sample.distance, sample.localRadius);
            const headSpeed = Math.hypot(maxHeadVx, maxHeadVy);
            if ((mid > 0 || outer > 0) && headSpeed > 7) {
              // Head motion still pushes nearby particles, but a perfectly
              // still head no longer generates a permanent tangential halo.
              const transfer = 1.55 * mid + 0.42 * outer;
              const outwardSpeed = Math.max(0, maxHeadVx * sample.normalX + maxHeadVy * sample.normalY);
              forceX += maxHeadVx * transfer + sample.normalX * outwardSpeed * (0.72 * mid);
              forceY += maxHeadVy * transfer + sample.normalY * outwardSpeed * (0.72 * mid);
            }
          }
        }
        // Continue the burst's own momentum for a short time after first
        // contact. This makes a stationary forehead visibly split and rebound
        // the incoming mass instead of looking like a static cut-out mask.
        for (let impact = 0; impact < this.impactActive.length; impact += 1) {
          if (!this.impactActive[impact]) continue;
          const normalX = this.impactNormalX[impact];
          const normalY = this.impactNormalY[impact];
          const tangentX = -normalY;
          const tangentY = normalX;
          const offsetX = x - this.impactX[impact];
          const offsetY = y - this.impactY[impact];
          const tangentOffset = offsetX * tangentX + offsetY * tangentY;
          const normalOffset = offsetX * normalX + offsetY * normalY;
          const radius = this.impactRadius[impact];
          const distance = Math.hypot(tangentOffset / radius, normalOffset / (radius * 0.66));
          if (distance >= 1) continue;
          const spatial = 1 - distance;
          const life = clamp(this.impactLife[impact] / 0.68, 0, 1);
          const falloff = spatial * spatial * (3 - 2 * spatial) * life * this.impactStrength[impact];
          const split = tangentOffset === 0 ? 1 : Math.sign(tangentOffset);
          forceX += normalX * 1420 * falloff + tangentX * split * 620 * falloff;
          forceY += normalY * 1420 * falloff + tangentY * split * 620 * falloff;
        }
        if (this.trailLockLife[index] > 0) {
          const lockNormalX = this.trailLockNormalX[index];
          const lockNormalY = this.trailLockNormalY[index];
          const inwardForce = forceX * lockNormalX + forceY * lockNormalY;
          if (inwardForce < 0) {
            forceX -= lockNormalX * inwardForce;
            forceY -= lockNormalY * inwardForce;
          }
        }
        const forceScale = Math.min(1, 2500 / (Math.hypot(forceX, forceY) || 1));
        this.vx[index] = (this.vx[index] + forceX * forceScale * safeDt) * velocityDamping;
        this.vy[index] = (this.vy[index] + forceY * forceScale * safeDt) * velocityDamping;
        const velocityScale = Math.min(1, 680 / (Math.hypot(this.vx[index], this.vy[index]) || 1));
        this.vx[index] *= velocityScale;
        this.vy[index] *= velocityScale;
        this.dx[index] = clamp(this.dx[index] + this.vx[index] * safeDt, -118, 118);
        this.dy[index] = clamp(this.dy[index] + this.vy[index] * safeDt, -118, 118);
        // Monotonic, very slow dissipation replaces the former spring force.
        // There is no acceleration back toward the face, so the contact cannot
        // produce a visible second bounce.
        if (this.trailLockLife[index] <= 0 && Math.abs(forceX) + Math.abs(forceY) < 0.01) {
          const dissipation = Math.exp(-0.34 * safeDt);
          this.dx[index] *= dissipation;
          this.dy[index] *= dissipation;
        }
        const offset = index * 4;
        const totalX = clamp(this.dx[index], -260, 260);
        const totalY = clamp(this.dy[index], -260, 260);
        let frameX = totalX - this.previousTotalX[index];
        let frameY = totalY - this.previousTotalY[index];
        if (this.trailNoReturn[index]) {
          // RG may settle gradually, but BA drives the already-rendered
          // feedback trail. Suppress only its inward recovery component so
          // bounced particles fade where they travelled instead of rewinding
          // back onto the forehead.
          const inward = frameX * this.trailLockNormalX[index] + frameY * this.trailLockNormalY[index];
          const returningToOrigin = frameX * this.previousTotalX[index] + frameY * this.previousTotalY[index] < 0;
          if (inward < 0 || returningToOrigin) {
            frameX = 0;
            frameY = 0;
          }
          if (Math.hypot(totalX, totalY) < 0.35) this.trailNoReturn[index] = 0;
        }
        if (this.trailLockLife[index] > 0) this.trailLockLife[index] = Math.max(0, this.trailLockLife[index] - safeDt);
        this.data[offset] = encodeSigned(totalX, 260);
        this.data[offset + 1] = encodeSigned(totalY, 260);
        this.data[offset + 2] = encodeSigned(clamp(frameX, -80, 80), 80);
        this.data[offset + 3] = encodeSigned(clamp(frameY, -80, 80), 80);
        this.previousTotalX[index] = totalX;
        this.previousTotalY[index] = totalY;
      }
    }
  }
}

function sampleContourOffset(
  head: HeadCollider, sourceX: number, sourceY: number, arcOffset: number, fallback: SurfaceSample,
) {
  const points = head.points;
  if (points && points.length >= 3) {
    const lengths = new Float32Array(points.length);
    let perimeter = 0;
    let primaryArc = 0;
    let nearestSquared = Infinity;
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      const edgeX = b.x - a.x;
      const edgeY = b.y - a.y;
      const length = Math.hypot(edgeX, edgeY);
      lengths[index] = length;
      const t = clamp(((sourceX - a.x) * edgeX + (sourceY - a.y) * edgeY)
        / Math.max(0.0001, length * length), 0, 1);
      const dx = sourceX - (a.x + edgeX * t);
      const dy = sourceY - (a.y + edgeY * t);
      const squared = dx * dx + dy * dy;
      if (squared < nearestSquared) {
        nearestSquared = squared;
        primaryArc = perimeter + length * t;
      }
      perimeter += length;
    }
    let targetArc = (primaryArc + arcOffset) % perimeter;
    if (targetArc < 0) targetArc += perimeter;
    let traversed = 0;
    for (let index = 0; index < points.length; index += 1) {
      const length = lengths[index];
      if (targetArc > traversed + length && index < points.length - 1) {
        traversed += length;
        continue;
      }
      const a = points[index];
      const b = points[(index + 1) % points.length];
      const t = clamp((targetArc - traversed) / Math.max(0.0001, length), 0, 1);
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      let normalX = b.y - a.y;
      let normalY = a.x - b.x;
      if (normalX * (x - head.cx) + normalY * (y - head.cy) < 0) {
        normalX = -normalX;
        normalY = -normalY;
      }
      const normalLength = Math.hypot(normalX, normalY) || 1;
      return { x, y, normalX: normalX / normalLength, normalY: normalY / normalLength };
    }
  }

  const primaryAngle = Math.atan2(
    (fallback.y - head.cy) / Math.max(1, head.ry),
    (fallback.x - head.cx) / Math.max(1, head.rx),
  );
  const angle = primaryAngle + arcOffset / Math.max(1, (head.rx + head.ry) * 0.5);
  const x = head.cx + Math.cos(angle) * head.rx;
  const y = head.cy + Math.sin(angle) * head.ry;
  let normalX = (x - head.cx) / Math.max(1, head.rx * head.rx);
  let normalY = (y - head.cy) / Math.max(1, head.ry * head.ry);
  const normalLength = Math.hypot(normalX, normalY) || 1;
  normalX /= normalLength;
  normalY /= normalLength;
  return { x, y, normalX, normalY };
}

function hashUnit(seed: number, salt: number) {
  const value = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function encodeSigned(value: number, range: number) {
  return Math.round(127.5 + Math.sign(value) * Math.sqrt(Math.min(1, Math.abs(value) / range)) * 127.5);
}

function segmentIntersectionT(
  pX: number, pY: number, p2X: number, p2Y: number,
  qX: number, qY: number, q2X: number, q2Y: number,
) {
  const rX = p2X - pX;
  const rY = p2Y - pY;
  const sX = q2X - qX;
  const sY = q2Y - qY;
  const denominator = rX * sY - rY * sX;
  if (Math.abs(denominator) < 0.000001) return null;
  const qMinusPX = qX - pX;
  const qMinusPY = qY - pY;
  const t = (qMinusPX * sY - qMinusPY * sX) / denominator;
  const u = (qMinusPX * rY - qMinusPY * rX) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
