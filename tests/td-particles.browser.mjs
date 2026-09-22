// Real WebGL regression: exercise the production renderer, then read its
// transform-feedback records. No mocked collision implementation is involved.
// PLAYWRIGHT_MODULE may point at an already installed Playwright index.mjs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.TEST_OUTPUT || '/private/tmp/smile-storm-gpu-regression';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const page = await browser.newPage({ viewport: { width: 600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (/error|warning/.test(m.type())) errors.push(m.text()); });
try {
  await page.route('**/__particle_fixture', route => route.fulfill({
    contentType: 'text/html', body: '<html><body style="margin:0;background:#080d14"><div id="mount"></div></body></html>',
  }));
  await page.goto(`${process.env.TEST_URL || 'http://localhost:4177'}/__particle_fixture`);
  await page.evaluate(async () => {
    const { TDParticleBurstRenderer } = await import('/src/TDParticleBurstRenderer.ts');
    window.makeRenderer = async () => {
      document.querySelector('#mount').replaceChildren();
      const renderer = new TDParticleBurstRenderer(document.querySelector('#mount'));
      if (!renderer.available) throw new Error('Production GPU renderer failed to initialize');
      renderer.resize(600, 900);
      const deadline = performance.now() + 5000;
      while (!renderer.imageTextures.every(Boolean) || !renderer.curve) {
        if (performance.now() > deadline) throw new Error('Particle textures/motion curve did not load');
        await new Promise(r => setTimeout(r, 20));
      }
      return renderer;
    };
    window.makeHead = (cx = 300, rotation = 0) => {
      const head = { cx, cy: 670, rx: 170, ry: 240, rotation, type: 'POLYGON', points: [] };
      for (let i = 0; i < 18; i++) {
        const angle = i * Math.PI * 2 / 18;
        const x = Math.cos(angle) * head.rx, y = Math.sin(angle) * head.ry;
        head.points.push({ x: cx + x * Math.cos(rotation) - y * Math.sin(rotation),
          y: head.cy + x * Math.sin(rotation) + y * Math.cos(rotation) });
      }
      return head;
    };
    window.inside = (x, y, points) => {
      let yes = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i], b = points[j];
        if ((a.y > y) !== (b.y > y) && x < (b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x) yes = !yes;
      }
      return yes;
    };
  });
  const results = [];
  for (const scenario of ['stationary', 'offset-rotated', 'moving']) {
    const result = await page.evaluate(async scenario => {
      const r = await window.makeRenderer();
      r.burst(300, 265, 1); r.slots[0].seed = 42;
      const metrics = { scenario, firstContact: null, bounced: 0, minOutward: Infinity,
        separatedOver30px: 0, penetrated: 0, returned: 0, firstNormal: null, frames: [] };
      const tracked = new Map();
      const captures = [];
      const preview = document.createElement('canvas'); preview.width = 600; preview.height = 900;
      const ctx = preview.getContext('2d');
      const stream = preview.captureStream(30), chunks = [];
      const recorder = scenario === 'stationary' ? new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' }) : null;
      recorder?.addEventListener('dataavailable', event => chunks.push(event.data));
      recorder?.start();
      for (let frame = 0; frame <= 216; frame++) {
        const t = frame / 60;
        const offset = scenario === 'offset-rotated' ? 110 : scenario === 'moving' ? Math.max(0, Math.min(100, (t-0.8)*150)) : 0;
        const head = window.makeHead(300 + offset, scenario === 'offset-rotated' ? 0.35 : 0);
        const vx = scenario === 'moving' && t > 0.8 && t < 1.466 ? 150 : 0;
        r.update(t, head, vx, 0, 1/60);
        // Read the very same buffers consumed by the visible point shader.
        if (frame % 6 === 0 && t < 3.2) {
          const state = r.debugSnapshot()[0];
          let hits = 0;
          for (let i = 0; i < state.length; i += 12) {
            const age = state[i+6];
            if (age < 0) continue;
            hits++;
            if (metrics.firstContact === null || state[i+7] < metrics.firstContact) {
              metrics.firstContact = state[i+7]; metrics.firstNormal = [state[i+4], state[i+5]];
            }
            const separation = (state[i]-state[i+10])*state[i+4] + (state[i+1]-state[i+11])*state[i+5];
            if (age < 0.15) metrics.minOutward = Math.min(metrics.minOutward, state[i+2]*state[i+4]+state[i+3]*state[i+5]);
            if (age > 0.2 && age < 1.2 && separation > 30) metrics.separatedOver30px++;
            if (age < 2.2 && window.inside(state[i], state[i+1], head.points)) metrics.penetrated++;
            if (scenario !== 'moving' && age < 2.2) {
              if (tracked.has(i) && separation < tracked.get(i) - 0.05) metrics.returned++;
              tracked.set(i, separation);
            }
          }
          metrics.bounced = Math.max(metrics.bounced, hits);
          metrics.frames.push({ t, hits, shownCount: r.bouncedCount });
        }
        if (scenario === 'stationary') {
          ctx.fillStyle = '#080d14'; ctx.fillRect(0,0,600,900);
          ctx.beginPath(); head.points.forEach((p,i) => i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y)); ctx.closePath();
          ctx.fillStyle = '#263540'; ctx.fill(); ctx.strokeStyle = '#668491'; ctx.lineWidth = 2; ctx.stroke();
          ctx.drawImage(r.canvas,0,0);
          ctx.fillStyle = '#d7e8f0'; ctx.font = '16px sans-serif';
          ctx.fillText(`Stationary head · actual GPU particles · ${t.toFixed(2)}s`,20,30);
          if ([18,30,42,60,90].includes(frame)) captures.push({ frame, png: preview.toDataURL('image/png').split(',')[1] });
        }
        if (frame === 216) {
          const pixels = new Uint8Array(r.canvas.width*r.canvas.height*4);
          r.gl.readPixels(0,0,r.canvas.width,r.canvas.height,r.gl.RGBA,r.gl.UNSIGNED_BYTE,pixels);
          metrics.residualChannels = pixels.reduce((n,x) => n+(x>0?1:0),0);
          metrics.glError = r.gl.getError();
        }
        await new Promise(requestAnimationFrame);
      }
      let video = null;
      if (recorder) {
        const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
        recorder.stop(); await stopped;
        video = await new Promise(resolve => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' }));
        });
      }
      stream.getTracks().forEach(track => track.stop());
      r.dispose();
      return { metrics, captures, video };
    }, scenario);
    for (const capture of result.captures) await writeFile(`${output}/stationary-${capture.frame}.png`, Buffer.from(capture.png, 'base64'));
    if (result.video) await writeFile(`${output}/stationary-head.webm`, Buffer.from(result.video, 'base64'));
    results.push(result.metrics);
    console.log(JSON.stringify(result.metrics));
    assert.ok(result.metrics.bounced > 1000, `${scenario}: main cloud must hit without head movement`);
    assert.ok(result.metrics.firstContact > 0 && result.metrics.firstContact < 0.8, `${scenario}: real first contact`);
    assert.ok(result.metrics.minOutward > 50, `${scenario}: velocity must reflect outward`);
    assert.ok(result.metrics.separatedOver30px > 500, `${scenario}: visible displacement`);
    assert.equal(result.metrics.penetrated, 0, `${scenario}: no live particle inside head`);
    assert.equal(result.metrics.returned, 0, `${scenario}: no spring-back`);
    assert.equal(result.metrics.residualChannels, 0, `${scenario}: completely transparent after expiry`);
    assert.equal(result.metrics.glError, 0, `${scenario}: no WebGL error`);
  }
  await page.goto(process.env.TEST_URL || 'http://localhost:4177');
  await page.waitForSelector('#start-button');
  assert.equal(await page.locator('canvas.td-burst-canvas').count(), 1, 'Main page uses the tested GPU renderer');
  await writeFile(`${output}/results.json`, JSON.stringify({ results, errors },null,2));
  assert.deepEqual(errors, [], 'No shader errors or WebGL warnings');
  console.log(`PASS: production GPU collision regression. Captures: ${output}`);
} finally { await browser.close(); }
