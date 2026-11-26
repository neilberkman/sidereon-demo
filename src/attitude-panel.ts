import { AttitudeMode } from "@neilberkman/sidereon";
import { ATTITUDE_DATE, ATTITUDE_SATELLITES, type AttitudePoint } from "./attitude";

const modes = {
  [AttitudeMode.Nominal]: { label: "Nominal", color: "#597e87" },
  [AttitudeMode.NoonTurn]: { label: "Noon turn", color: "#ffbd66" },
  [AttitudeMode.MidnightTurn]: { label: "Midnight turn", color: "#a7a8ff" },
  [AttitudeMode.Shadow]: { label: "Shadow", color: "#e789a8" },
  [AttitudeMode.OrbitNormal]: { label: "Orbit normal", color: "#9bd678" },
  [AttitudeMode.ModifiedYawSteering]: { label: "Modified yaw steering", color: "#d8a181" },
};

const day = 86400;
const yawColor = "#56e5f0";
const nominalColor = "#bdcdd5";
const betaColor = "#ffbd66";

function wrapYaw(deg: number): number {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

function drawChart(canvas: HTMLCanvasElement, points: AttitudePoint[]): void {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.ceil(width * dpr);
  canvas.height = Math.ceil(height * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  if (!points.length) return;

  const left = 48;
  const right = width - 20;
  const top = 25;
  const bottom = height - 27;
  const yawBottom = top + (bottom - top) * 0.64;
  const betaTop = yawBottom + 44;
  const x = (second: number) => left + second / day * (right - left);
  const yYaw = (angle: number) => top + (180 - angle) / 360 * (yawBottom - top);
  const betas = points.map((p) => p.betaDeg);
  const betaMin = Math.min(...betas);
  const betaMax = Math.max(...betas);
  const betaLow = Math.floor(betaMin * 10) / 10;
  const betaHigh = Math.max(betaLow + 0.1, Math.ceil(betaMax * 10) / 10);
  const yBeta = (angle: number) => betaTop + (betaHigh - angle) / (betaHigh - betaLow) * (bottom - betaTop);

  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#9fc4c8";
  ctx.fillText("YAW (°)", left, 12);
  ctx.fillText("MODE", 8, yawBottom + 13);
  ctx.fillText("SUN ELEVATION β (°)", left, betaTop - 12);

  const grid = (value: number, y: number) => {
    ctx.strokeStyle = "#253d47";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillStyle = "#9fc4c8";
    ctx.textAlign = "right";
    ctx.fillText(String(value), left - 7, y);
    ctx.textAlign = "left";
  };
  for (const tick of [-180, -90, 0, 90, 180]) grid(tick, yYaw(tick));
  grid(Number(betaHigh.toFixed(1)), betaTop);
  grid(betaLow, bottom);
  for (const hour of [0, 6, 12, 18, 24]) {
    const at = x(hour * 3600);
    ctx.beginPath();
    ctx.moveTo(at, top);
    ctx.lineTo(at, bottom);
    ctx.stroke();
    ctx.fillText(String(hour).padStart(2, "0"), at - 6, bottom + 15);
  }
  ctx.fillText("UTC", 8, bottom + 15);

  function trace(values: number[], scale: (angle: number) => number, color: string, dashed = false): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = dashed ? 1.4 : 2;
    ctx.setLineDash(dashed ? [4, 5] : []);
    ctx.beginPath();
    values.forEach((value, i) => {
      const at = x(points[i].elapsedS);
      if (i === 0 || Math.abs(value - values[i - 1]) > 180) ctx.moveTo(at, scale(value));
      else ctx.lineTo(at, scale(value));
    });
    ctx.stroke();
  }
  trace(points.map((p) => wrapYaw(p.yawDeg)), yYaw, yawColor);
  trace(points.map((p) => wrapYaw(p.nominalDeg)), yYaw, nominalColor, true);
  trace(betas, yBeta, betaColor);
  let bandStart = left;
  points.forEach((p, i) => {
    const next = points[i + 1];
    if (next?.mode === p.mode) return;
    const bandEnd = next ? x((p.elapsedS + next.elapsedS) / 2) : right;
    ctx.fillStyle = modes[p.mode].color;
    ctx.fillRect(bandStart, yawBottom + 9, bandEnd - bandStart, 8);
    bandStart = bandEnd;
  });
}

function utcTime(seconds: number): string {
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}`;
}

export function setupAttitudePanel(load: (satellite: string) => Promise<AttitudePoint[]>) {
  const select = document.querySelector<HTMLSelectElement>("#attitude-satellite")!;
  const canvas = document.querySelector<HTMLCanvasElement>("#attitude-chart")!;
  const status = document.getElementById("attitude-status")!;
  const legend = document.getElementById("attitude-legend")!;
  const satelliteOptions = Object.entries(ATTITUDE_SATELLITES);
  for (const [satellite, block] of satelliteOptions) {
    select.add(new Option(`${satellite} · ${block}`, satellite));
  }
  select.value = "G09";
  document.getElementById("attitude-date")!.textContent = ATTITUDE_DATE;

  let points: AttitudePoint[] = [];
  let tableHost: HTMLElement | null = null;
  let request = 0;
  const cache = new Map<string, Promise<AttitudePoint[]>>();
  const resize = new ResizeObserver(() => drawChart(canvas, points));
  resize.observe(canvas);

  function renderTable(): void {
    if (!tableHost) return;
    tableHost.innerHTML = points.length ? `<table class="ov-table">
      <caption>Attitude samples · yaw angles as returned by the law</caption>
      <thead><tr><th scope="col">UTC</th><th scope="col">TDB s past J2000</th><th scope="col">YAW °</th>
        <th scope="col">NOMINAL °</th><th scope="col">β °</th><th scope="col">MODE</th></tr></thead>
      <tbody>${points.map((p) => `<tr><td>${utcTime(p.elapsedS)}</td><td>${p.tdbS.toFixed(3)}</td><td>${p.yawDeg.toFixed(4)}</td>
        <td>${p.nominalDeg.toFixed(4)}</td><td>${p.betaDeg.toFixed(4)}</td><td>${modes[p.mode].label}</td></tr>`).join("")}</tbody>
    </table>` : "";
  }

  const key = (label: string, color: string, style = "") =>
    `<span><i class="${style}" style="--key-color:${color}"></i>${label}</span>`;

  async function update(): Promise<void> {
    const satellite = select.value;
    const current = ++request;
    points = [];
    canvas.removeAttribute("data-satellite");
    status.textContent = `Computing ${satellite} attitude…`;
    legend.textContent = "";
    drawChart(canvas, points);
    renderTable();

    try {
      let pending = cache.get(satellite);
      if (!pending) {
        pending = load(satellite).catch((error) => {
          cache.delete(satellite);
          throw error;
        });
        cache.set(satellite, pending);
      }
      const samples = await pending;
      if (current !== request) return;
      points = samples;
      const present = new Set(points.map((p) => p.mode));
      const betas = points.map((p) => p.betaDeg);
      legend.innerHTML = [
        key("Yaw", yawColor, "line"),
        key("Nominal yaw", nominalColor, "dashed"),
        key("Sun elevation β", betaColor, "line"),
        ...Object.entries(modes).filter(([mode]) => present.has(Number(mode))).map(([, mode]) => key(mode.label, mode.color)),
      ].join("");
      status.textContent = `${samples.length} samples · β ${Math.min(...betas).toFixed(2)}° to ${Math.max(...betas).toFixed(2)}°`;
      drawChart(canvas, points);
      renderTable();
      canvas.dataset.satellite = satellite;
    } catch (error) {
      if (current === request) status.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  select.addEventListener("change", () => void update());
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    if (!request) void update();
  }, { rootMargin: "300px" });
  observer.observe(canvas);

  return (host: HTMLElement | null) => {
    tableHost = host;
    renderTable();
  };
}
