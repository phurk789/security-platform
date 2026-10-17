// Procedural textures (no image downloads): site ground plan, building facades, roofs, noise.
import * as THREE from 'three';
import { BUILDINGS, FENCE_Y, GATE, PARKING, PLAZA, ROAD, SITE } from '@13store/shared';
import { rng } from './layout';

const PX = 4; // texture pixels per metre for the ground plan

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, n: number, alpha: number, seed: number) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const v = Math.floor(r() * 255);
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * r()})`;
    ctx.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2);
  }
}

/** The whole site plan painted onto one texture: grass, paving, car park, plaza, road, kerbs. */
export function groundTexture(maxAniso = 4) {
  const W = SITE.width * PX;
  const H = SITE.height * PX;
  const [c, g] = canvas(W, H);
  const m = (v: number) => v * PX;

  // grass with mottling
  g.fillStyle = '#16251f';
  g.fillRect(0, 0, W, H);
  const r = rng(3);
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = r() > 0.5 ? 'rgba(40,70,52,0.18)' : 'rgba(8,18,14,0.22)';
    g.beginPath();
    g.arc(r() * W, r() * H, 4 + r() * 18, 0, Math.PI * 2);
    g.fill();
  }

  // paved precinct inside the fence
  g.fillStyle = '#3a4552';
  g.fillRect(m(16), m(14), m(388), m(FENCE_Y - 14));
  // lawns inside the precinct
  g.fillStyle = '#22382d';
  for (const [x, y, w, h] of [
    [24, 20, 210, 90],
    [24, 128, 210, 100],
    [252, 20, 146, 90],
    [252, 128, 146, 100],
  ]) g.fillRect(m(x), m(y), m(w), m(h));
  speckle(g, W, H, 14000, 0.16, 11);

  // footpaths
  g.fillStyle = '#3a4552';
  g.fillRect(m(240), m(14), m(8), m(FENCE_Y - 14));
  g.fillRect(m(16), m(116), m(388), m(8));
  g.fillRect(m(GATE.x - 2), m(FENCE_Y - 30), m(GATE.w + 4), m(30));
  // building aprons
  for (const b of BUILDINGS) {
    g.fillStyle = '#2e3945';
    g.fillRect(m(b.x - 4), m(b.y - 4), m(b.w + 8), m(b.d + 8));
  }

  // plaza
  g.fillStyle = '#34404d';
  g.beginPath();
  g.arc(m(PLAZA.cx), m(PLAZA.cy), m(PLAZA.r), 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(200,210,220,0.25)';
  g.lineWidth = m(0.4);
  for (const rr of [PLAZA.r - 3, 9]) {
    g.beginPath();
    g.arc(m(PLAZA.cx), m(PLAZA.cy), m(rr), 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = '#1d3a4a';
  g.beginPath();
  g.arc(m(PLAZA.cx), m(PLAZA.cy), m(7), 0, Math.PI * 2);
  g.fill();

  // car park asphalt + bays
  g.fillStyle = '#1b222b';
  g.fillRect(m(PARKING.x), m(PARKING.y), m(PARKING.w), m(PARKING.d));
  speckle(g, W, H, 0, 0, 1);
  g.strokeStyle = 'rgba(230,236,242,0.55)';
  g.lineWidth = m(0.18);
  for (let i = 0; i <= 13; i++) {
    const x = PARKING.x + 4 + i * 8;
    g.beginPath();
    g.moveTo(m(x), m(PARKING.y));
    g.lineTo(m(x), m(PARKING.y + 11));
    g.moveTo(m(x), m(PARKING.y + PARKING.d - 11));
    g.lineTo(m(x), m(PARKING.y + PARKING.d));
    g.stroke();
  }

  // public road outside the fence, with kerbs, centre line and a zebra at the gate
  g.fillStyle = '#3b444f';
  g.fillRect(0, m(FENCE_Y + 1), W, m(ROAD.y - FENCE_Y - 1));
  g.fillStyle = '#161c23';
  g.fillRect(0, m(ROAD.y), W, m(ROAD.h));
  speckle(g, W, H, 9000, 0.12, 21);
  g.strokeStyle = 'rgba(240,240,230,0.7)';
  g.lineWidth = m(0.2);
  g.setLineDash([m(3), m(3)]);
  g.beginPath();
  g.moveTo(0, m(ROAD.y + ROAD.h / 2));
  g.lineTo(W, m(ROAD.y + ROAD.h / 2));
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = 'rgba(240,240,230,0.5)';
  for (const y of [ROAD.y + 0.6, ROAD.y + ROAD.h - 0.6]) {
    g.beginPath();
    g.moveTo(0, m(y));
    g.lineTo(W, m(y));
    g.stroke();
  }
  g.fillStyle = 'rgba(240,240,230,0.75)';
  for (let i = 0; i < 7; i++) g.fillRect(m(GATE.x + 1 + i * 3.6), m(ROAD.y + 1.2), m(1.8), m(ROAD.h - 2.4));
  // arrow on the gate driveway (as in the CCTV view)
  g.fillStyle = 'rgba(240,240,230,0.6)';
  g.beginPath();
  const ax = m(GATE.x + GATE.w / 2);
  const ay = m(FENCE_Y - 10);
  g.moveTo(ax, ay - m(3));
  g.lineTo(ax + m(1.6), ay);
  g.lineTo(ax + m(0.5), ay);
  g.lineTo(ax + m(0.5), ay + m(3));
  g.lineTo(ax - m(0.5), ay + m(3));
  g.lineTo(ax - m(0.5), ay);
  g.lineTo(ax - m(1.6), ay);
  g.closePath();
  g.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  tex.generateMipmaps = true;
  return tex;
}

/** Facade tile: 4 windows × 4 floors. `lit` returns the emissive map with only the lit windows. */
export function facadeTextures(seed: number) {
  const S = 256;
  const [c, g] = canvas(S, S);
  const [e, ge] = canvas(S, S);
  g.fillStyle = '#6a7484';
  g.fillRect(0, 0, S, S);
  speckle(g, S, S, 1600, 0.12, seed);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, S, S);
  const r = rng(seed * 7 + 3);
  const cw = S / 4;
  const ch = S / 4;
  for (let f = 0; f < 4; f++) {
    // floor slab line
    g.fillStyle = '#3a4350';
    g.fillRect(0, f * ch + ch - 6, S, 6);
    for (let w = 0; w < 4; w++) {
      const x = w * cw + 8;
      const y = f * ch + 10;
      const ww = cw - 16;
      const wh = ch - 26;
      const lit = r() > 0.68;
      const warm = r() > 0.25;
      g.fillStyle = lit ? (warm ? '#d9b46a' : '#a9c4dd') : '#1b2430';
      g.fillRect(x, y, ww, wh);
      // mullion
      g.fillStyle = '#2b333e';
      g.fillRect(x + ww / 2 - 1, y, 2, wh);
      if (lit) {
        const grd = ge.createLinearGradient(0, y, 0, y + wh);
        grd.addColorStop(0, warm ? '#ffd58a' : '#bcd9ff');
        grd.addColorStop(1, warm ? '#b9863b' : '#6f8fb3');
        ge.fillStyle = grd;
        ge.fillRect(x, y, ww, wh);
      }
    }
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  const emissive = new THREE.CanvasTexture(e);
  emissive.colorSpace = THREE.SRGBColorSpace;
  emissive.wrapS = emissive.wrapT = THREE.RepeatWrapping;
  return { map, emissive };
}

export function roofTexture() {
  const S = 128;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#7a8494';
  g.fillRect(0, 0, S, S);
  speckle(g, S, S, 1200, 0.18, 5);
  g.strokeStyle = 'rgba(30,36,44,0.35)';
  for (let i = 0; i < S; i += 16) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, S);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Soft radial gradient for glow sprites and lamp pools. */
export function glowTexture(inner = 'rgba(255,230,180,1)', outer = 'rgba(255,230,180,0)') {
  const S = 128;
  const [c, g] = canvas(S, S);
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Vertical fade used for light beams over incidents. */
export function beamTexture() {
  const [c, g] = canvas(4, 128);
  const grd = g.createLinearGradient(0, 0, 0, 128);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(1, 'rgba(255,255,255,0.9)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 128);
  const t = new THREE.CanvasTexture(c);
  return t;
}

/** Striped red/white texture for the barrier arm. */
export function stripeTexture() {
  const [c, g] = canvas(64, 8);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? '#f2f4f7' : '#d33a3a';
    g.fillRect(i * 8, 0, 8, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
