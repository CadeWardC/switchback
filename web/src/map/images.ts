// Small pictures the map draws: trailhead pins, numbered groups of pins, and text labels.
// They are painted here on a canvas, so they need no icon files and no map fonts (which come from the
// base map's server and may not be reachable).
import type { Map as MlMap } from 'maplibre-gl';
import { dark, difficultyColors, font, light, mapColors } from '../tokens';

const RATIO = 2;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * RATIO);
  c.height = Math.ceil(h * RATIO);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.scale(RATIO, RATIO);
  return [c, ctx];
}

function add(map: MlMap, id: string, c: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const data = ctx.getImageData(0, 0, c.width, c.height);
  if (!map.hasImage(id)) map.addImage(id, { width: c.width, height: c.height, data: new Uint8Array(data.data.buffer) }, { pixelRatio: RATIO });
}

function shadowed(ctx: CanvasRenderingContext2D, draw: () => void): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  draw();
  ctx.restore();
}

/** A trailhead: a dot in the trail's difficulty colour with a small white peak. */
function pin(map: MlMap, id: string, color: string): void {
  const s = 30, r = 11;
  const [c, ctx] = canvas(s, s);
  shadowed(ctx, () => {
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
  });
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  // two peaks
  ctx.beginPath();
  ctx.moveTo(8.5, 19.5);
  ctx.lineTo(13, 11.5);
  ctx.lineTo(15.6, 15.6);
  ctx.lineTo(17.6, 13);
  ctx.lineTo(21.5, 19.5);
  ctx.closePath();
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  add(map, id, c, ctx);
}

/** Several trailheads close together: a bubble with how many. */
function cluster(map: MlMap, id: string, text: string, isDark: boolean): void {
  const p = isDark ? dark : light;
  const r = text.length >= 3 ? 19 : text.length === 2 ? 17 : 15, s = r * 2 + 8;
  const [c, ctx] = canvas(s, s);
  shadowed(ctx, () => {
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
  });
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
  ctx.fillStyle = p.primary;
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 13px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, s / 2, s / 2 + 0.5);
  add(map, id, c, ctx);
}

/** A rounded label with one or two lines of text (the second smaller). */
function label(map: MlMap, id: string, text: string, isDark: boolean): void {
  const p = isDark ? dark : light;
  const [title, sub] = text.split('\n');
  const [, measure] = canvas(1, 1);
  measure.font = `650 13px ${font}`;
  const w1 = measure.measureText(title).width;
  measure.font = `500 11px ${font}`;
  const w2 = sub ? measure.measureText(sub).width : 0;
  const w = Math.ceil(Math.max(w1, w2)) + 22, h = sub ? 40 : 26;
  const [c, ctx] = canvas(w + 6, h + 6);
  shadowed(ctx, () => {
    ctx.beginPath();
    ctx.roundRect(3, 2, w, h, 10);
    ctx.fillStyle = p.card;
    ctx.fill();
  });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = p.ink;
  ctx.font = `650 13px ${font}`;
  ctx.fillText(title, 3 + w / 2, sub ? 14 : 2 + h / 2 + 0.5);
  if (sub) {
    ctx.fillStyle = p.muted;
    ctx.font = `500 11px ${font}`;
    ctx.fillText(sub, 3 + w / 2, 30);
  }
  add(map, id, c, ctx);
}

/** A soft wedge pointing the way you are heading, drawn around the location dot. */
function heading(map: MlMap, id: string): void {
  const s = 56;
  const [c, ctx] = canvas(s, s);
  const g = ctx.createRadialGradient(s / 2, s / 2, 6, s / 2, s / 2, 27);
  g.addColorStop(0, mapColors.me);
  g.addColorStop(1, 'rgba(43,127,217,0)');
  ctx.beginPath();
  ctx.moveTo(s / 2, s / 2);
  ctx.arc(s / 2, s / 2, 27, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
  ctx.closePath();
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = g;
  ctx.fill();
  add(map, id, c, ctx);
}

/** Makes the picture a layer asked for ("pin-easy", "cluster-12", "label-Missouri\n3,156 trails"). */
export function makeImage(map: MlMap, id: string, isDark: boolean): void {
  try {
    if (id.startsWith('pin-')) pin(map, id, (difficultyColors as Record<string, string>)[id.slice(4)] ?? difficultyColors.easy);
    else if (id.startsWith('cluster-')) cluster(map, id, id.slice(8), isDark);
    else if (id === 'me-heading') heading(map, id);
    else if (id.startsWith('label-')) label(map, id, id.slice(6), isDark);
  } catch (e) {
    console.warn('map picture failed', id, e);
  }
}
