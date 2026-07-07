export interface PassTiming {
  aosISO: string;
  losISO?: string;
  upNow?: boolean;
}

export function hhmmZ(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "--:--Z";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
}

export function passTimingLabel(pass: PassTiming, referenceMs = Date.now()): string {
  const aosMs = Date.parse(pass.aosISO);
  const losMs = pass.losISO ? Date.parse(pass.losISO) : Number.NaN;
  const upNow =
    pass.upNow ??
    (Number.isFinite(aosMs) && Number.isFinite(losMs) && aosMs <= referenceMs && referenceMs < losMs);

  if (upNow && pass.losISO) return `UP · LOS ${hhmmZ(pass.losISO)}`;
  return `AOS ${hhmmZ(pass.aosISO)}`;
}
