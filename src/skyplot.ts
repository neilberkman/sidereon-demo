// Animated polar azimuth/elevation skyplot. North up, east right; elevation is
// the radial axis (90 deg zenith at centre, horizon at the rim). Every dot is a
// real satellite whose az/el comes from the engine's SGP4 + topocentric look
// angles; every arc is that satellite's real computed track across the local sky
// over a +/- time window. Nothing here is decorative data: the radar sweep and
// ring glow are instrument styling, the satellites and their pass arcs are live.

import { CONSTELLATION, type Constellation } from "./colors";

export interface SkyPoint {
  prn: string;
  az: number;
  el: number;
  constellation: Constellation;
  highlight?: boolean;
}

// One satellite's real sky track over a time window (az/el sampled from the
// engine), with the index of the sample nearest "now" so the past arc and the
// upcoming pass arc can be drawn differently.
export interface SkyArc {
  prn: string;
  constellation: Constellation;
  pts: { az: number; el: number }[];
  nowIdx: number;
}

const TWO_PI = Math.PI * 2;

export class Skyplot {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private points: SkyPoint[] = [];
  private arcs: SkyArc[] = [];
  private maskDeg: number;
  private sweep = 0; // radians, the radar sweep heading
  private raf = 0;
  private last = 0;
  private running = false;

  constructor(canvas: HTMLCanvasElement, maskDeg = 10) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.maskDeg = maskDeg;
  }

  setMask(deg: number): void {
    this.maskDeg = deg;
  }

  setPoints(points: SkyPoint[]): void {
    this.points = points;
  }

  setArcs(arcs: SkyArc[]): void {
    this.arcs = arcs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this.sweep = (this.sweep + dt * 1.1) % TWO_PI; // ~5.7 s per revolution
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    this.stop();
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = Math.min(devicePixelRatio, 2);
    const size = this.canvas.clientWidth || 240;
    if (this.canvas.width !== Math.round(size * dpr)) {
      this.canvas.width = Math.round(size * dpr);
      this.canvas.height = Math.round(size * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - Math.max(18, size * 0.07);
    const small = size < 320;
    const elToR = (el: number) => (1 - Math.max(0, Math.min(90, el)) / 90) * R;
    const xy = (az: number, el: number): [number, number] => {
      const r = elToR(el);
      const ang = (az - 90) * (Math.PI / 180);
      return [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r];
    };

    // deep-space dome fill: a faint radial well so the dots float in depth
    const dome = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    dome.addColorStop(0, "rgba(10,34,40,0.55)");
    dome.addColorStop(0.62, "rgba(6,16,22,0.34)");
    dome.addColorStop(1, "rgba(3,7,12,0.06)");
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TWO_PI);
    ctx.fillStyle = dome;
    ctx.fill();

    // radar sweep wedge (instrument styling), clipped to the dome
    this.drawSweep(ctx, cx, cy, R);

    // elevation rings + labels
    ctx.lineWidth = 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let el = 0; el <= 90; el += 30) {
      const r = elToR(el);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TWO_PI);
      ctx.strokeStyle = el === 0 ? "rgba(53,224,216,0.42)" : "rgba(53,224,216,0.12)";
      ctx.lineWidth = el === 0 ? 1.4 : 1;
      ctx.stroke();
      if (el > 0 && el < 90) {
        ctx.fillStyle = "rgba(120,200,205,0.5)";
        ctx.font = `${small ? 8 : 9}px 'IBM Plex Mono', monospace`;
        ctx.fillText(`${el}°`, cx + 1, cy - r - 1);
      }
    }
    // horizon rim glow
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TWO_PI);
    ctx.strokeStyle = "rgba(53,224,216,0.18)";
    ctx.lineWidth = 5;
    ctx.stroke();

    // azimuth spokes + cardinal labels
    ctx.strokeStyle = "rgba(53,224,216,0.08)";
    ctx.lineWidth = 1;
    for (let a = 0; a < 360; a += 30) {
      const ang = (a - 90) * (Math.PI / 180);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(150,220,225,0.8)";
    ctx.font = `${small ? 10 : 12}px 'IBM Plex Sans Condensed', monospace`;
    for (const [a, t] of [[0, "N"], [90, "E"], [180, "S"], [270, "W"]] as [number, string][]) {
      const ang = (a - 90) * (Math.PI / 180);
      ctx.fillText(t, cx + Math.cos(ang) * (R + (small ? 9 : 12)), cy + Math.sin(ang) * (R + (small ? 9 : 12)));
    }

    // elevation-mask ring (amber, dashed)
    const rm = elToR(this.maskDeg);
    ctx.beginPath();
    ctx.arc(cx, cy, rm, 0, TWO_PI);
    ctx.strokeStyle = "rgba(255,179,71,0.5)";
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.setLineDash([]);

    // pass arcs: each visible satellite's real track. Past leg solid + fading,
    // upcoming leg dashed and dim, so the dome reads as a web of live passes.
    for (const arc of this.arcs) {
      const col = CONSTELLATION[arc.constellation].css;
      this.drawArcLeg(ctx, arc, xy, 0, arc.nowIdx, col, false);
      this.drawArcLeg(ctx, arc, xy, arc.nowIdx, arc.pts.length - 1, col, true);
    }

    // live satellites
    for (const p of this.points) {
      if (p.el < 0) continue;
      const [x, y] = xy(p.az, p.el);
      const col = CONSTELLATION[p.constellation].css;
      const core = p.highlight ? (small ? 3.6 : 4.6) : small ? 2.4 : 3.2;
      // soft halo
      const halo = ctx.createRadialGradient(x, y, 0, x, y, core * 3.4);
      halo.addColorStop(0, hexA(col, 0.55));
      halo.addColorStop(1, hexA(col, 0));
      ctx.beginPath();
      ctx.arc(x, y, core * 3.4, 0, TWO_PI);
      ctx.fillStyle = halo;
      ctx.fill();
      if (p.highlight) {
        ctx.beginPath();
        ctx.arc(x, y, core + 3.5, 0, TWO_PI);
        ctx.strokeStyle = hexA(col, 0.8);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // bright core
      ctx.beginPath();
      ctx.arc(x, y, core, 0, TWO_PI);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x - core * 0.28, y - core * 0.28, core * 0.4, 0, TWO_PI);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fill();
      // label
      if (p.el > 12 && !small) {
        ctx.fillStyle = "rgba(224,244,246,0.9)";
        ctx.font = "8px 'IBM Plex Mono', monospace";
        ctx.textAlign = "center";
        ctx.fillText(p.prn, x, y - core - 6);
      }
    }

    // zenith crosshair
    ctx.strokeStyle = "rgba(53,224,216,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy);
    ctx.lineTo(cx + 4, cy);
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx, cy + 4);
    ctx.stroke();
  }

  private drawSweep(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TWO_PI);
    ctx.clip();
    // trailing wedge behind the sweep line
    const steps = 28;
    const span = 1.1; // radians of trail
    for (let i = 0; i < steps; i++) {
      const a0 = this.sweep - (i / steps) * span;
      const a1 = this.sweep - ((i + 1) / steps) * span;
      const alpha = (1 - i / steps) * 0.1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a1, true);
      ctx.closePath();
      ctx.fillStyle = `rgba(53,224,216,${alpha})`;
      ctx.fill();
    }
    // leading edge
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(this.sweep) * R, cy + Math.sin(this.sweep) * R);
    ctx.strokeStyle = "rgba(108,247,255,0.45)";
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }

  private drawArcLeg(
    ctx: CanvasRenderingContext2D,
    arc: SkyArc,
    xy: (az: number, el: number) => [number, number],
    from: number,
    to: number,
    col: string,
    future: boolean,
  ): void {
    ctx.lineWidth = future ? 1 : 1.4;
    ctx.setLineDash(future ? [2, 4] : []);
    for (let i = from; i < to; i++) {
      const a = arc.pts[i];
      const b = arc.pts[i + 1];
      if (!a || !b) continue;
      if (a.el < 0 || b.el < 0) continue;
      if (Math.abs(a.az - b.az) > 180) continue; // azimuth wrap: pen up
      const [x0, y0] = xy(a.az, a.el);
      const [x1, y1] = xy(b.az, b.el);
      // past leg brightens toward "now"; future leg is uniformly dim
      const f = (i - from) / Math.max(1, to - from);
      const alpha = future ? 0.16 : 0.1 + f * 0.4;
      ctx.strokeStyle = hexA(col, alpha);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

// "#rrggbb" + alpha -> "rgba(...)". The constellation palette is all #rrggbb.
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
