#!/usr/bin/env python3
"""Run the public PPP correction comparison.

This script expects sidereon==0.25.0 in the active Python environment.
It downloads public RINEX, broadcast NAV, ITRF station coordinates, and
correction captures as needed into data/ beside this file, then writes the
analysis outputs into output/.

Produced outputs include per-source convergence CSVs, station and cross-station
summaries, SPP seed diagnostics, code-bias usage, correction coverage,
correction message inventory, satellite-set checks, and materialized SP3 files.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import math
import shutil
import statistics
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

import numpy as np
import sidereon

C_M_S = 299_792_458.0
GPS_WEEK = 2426
WEEK_START_J2000 = sidereon.j2000_seconds(2026, 7, 5, 0, 0, 0.0)
DAY_START_TOW = 3 * 86400.0
START_TOW = 3 * 86400.0 + 19 * 3600.0 + 33 * 60.0
END_TOW = 3 * 86400.0 + 21 * 3600.0 + 3 * 60.0
MAX_SSR_STALENESS_S = 300.0
DAY_OF_YEAR = 189.0
SUSTAINED_TAIL_EPOCHS = 3

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RAW = DATA / "raw"
CORR = DATA / "corrections"
OUT = ROOT / "output"
SP3_DIR = OUT / "sp3"

BKG_HIGH_RATE_BASE = "https://igs.bkg.bund.de/root_ftp/IGS/highrate/2026/189"
NAV_URL = "https://igs.bkg.bund.de/root_ftp/IGS/BRDC/2026/189/BRDC00WRD_S_20261890000_01D_MN.rnx.gz"
ITRF_URL = "https://datacenter.iers.org/products/reference-systems/terrestrial/itrf/itrf2020/ITRF2020_GNSS.SSC.txt"
CORRECTIONS_BASE = "https://sidereon.dev/has-vs-ssr-ppp/files/data/corrections"


@dataclass(frozen=True)
class StationSpec:
    marker: str
    archive_prefix: str
    description: str


@dataclass
class RawEpoch:
    tow_s: float
    dt: datetime
    civil: sidereon.PppCivilDateTime
    jd_whole: float
    jd_fraction: float
    j2000_s: float
    by_sat: dict[str, dict[str, tuple[float, float]]]


@dataclass
class PppEpochBuild:
    station: str
    source: str
    epochs: list[sidereon.PppEpoch]
    observation_counts: list[int]
    input_satellites: list[list[str]]


@dataclass
class SourceResult:
    station: str
    source: str
    rows: list[dict[str, object]]


@dataclass
class TruthState:
    position_2015_m: np.ndarray
    velocity_m_y: np.ndarray


STATIONS = [
    StationSpec("DLF1", "DLF100NLD_R", "Delft, Netherlands"),
    StationSpec("DYNG", "DYNG00GRC_R", "Dionysos, Greece"),
    StationSpec("EBRE", "EBRE00ESP_R", "Roquetes, Spain"),
]

# PPP observable choices. The stream_signal fields use sidereon's RTCM signal
# ids for SsrCorrectionStore.code_bias(); missing entries stay unadjusted and
# are counted in output/code_bias_usage.csv.
SIGNAL_PAIRS = {
    "G": {
        "system": sidereon.GnssSystem.GPS,
        "c1": "C1C",
        "l1": "L1C",
        "f1": 1575.42e6,
        "b1_signal": 2,
        "c2": "C2W",
        "l2": "L2W",
        "f2": 1227.60e6,
        "b2_signal": 10,
        "label": "L1/L2",
    },
    "E": {
        "system": sidereon.GnssSystem.GALILEO,
        "c1": "C1X",
        "l1": "L1X",
        "f1": 1575.42e6,
        "b1_signal": 5,
        "c2": "C5X",
        "l2": "L5X",
        "f2": 1176.45e6,
        "b2_signal": 24,
        "label": "E1/E5a",
    },
}


def observation_urls(spec: StationSpec) -> list[str]:
    parts = [
        ("t", "1930"),
        ("t", "1945"),
        ("u", "2000"),
        ("u", "2015"),
        ("u", "2030"),
        ("u", "2045"),
        ("v", "2100"),
    ]
    return [
        f"{BKG_HIGH_RATE_BASE}/{hour_dir}/{spec.archive_prefix}_2026189{hhmm}_15M_01S_MO.crx.gz"
        for hour_dir, hhmm in parts
    ]


def download(url: str, path: Path) -> None:
    if path.exists() and path.stat().st_size > 0:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as resp:
        path.write_bytes(resp.read())


def ensure_inputs() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    CORR.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    for spec in STATIONS:
        for url in observation_urls(spec):
            download(url, RAW / url.rsplit("/", 1)[1])
    download(NAV_URL, RAW / NAV_URL.rsplit("/", 1)[1])
    download(ITRF_URL, DATA / "ITRF2020_GNSS.SSC.txt")
    for name in ["HAS_SSRA00EUH0_20260708_1933.rtcm3", "IGS_SSRA03IGS0_20260708_1933.rtcm3"]:
        download(f"{CORRECTIONS_BASE}/{name}", CORR / name)


def decimal_year(dt: datetime) -> float:
    start = datetime(dt.year, 1, 1, tzinfo=timezone.utc)
    end = datetime(dt.year + 1, 1, 1, tzinfo=timezone.utc)
    return dt.year + (dt - start).total_seconds() / (end - start).total_seconds()


def parse_itrf_truth(path: Path) -> dict[str, TruthState]:
    lines = path.read_text(errors="ignore").splitlines()
    out: dict[str, TruthState] = {}
    wanted = {spec.marker for spec in STATIONS}
    for idx, line in enumerate(lines[:-1]):
        if " GNSS " not in line:
            continue
        parts = line.split()
        marker_index = None
        for marker in wanted:
            if marker in parts:
                marker_index = parts.index(marker)
                break
        if marker_index is None:
            continue
        marker = parts[marker_index]
        try:
            pos = np.array([float(parts[marker_index + 1]), float(parts[marker_index + 2]), float(parts[marker_index + 3])], dtype=float)
            vel_parts = lines[idx + 1].split()
            vel = np.array([float(vel_parts[1]), float(vel_parts[2]), float(vel_parts[3])], dtype=float)
        except (IndexError, ValueError):
            continue
        out[marker] = TruthState(pos, vel)
    missing = sorted(wanted - set(out))
    if missing:
        raise RuntimeError(f"missing ITRF2020 truth rows for {missing}")
    return out


def truth_ecef(truth: TruthState, dt: datetime) -> np.ndarray:
    return truth.position_2015_m + truth.velocity_m_y * (decimal_year(dt) - 2015.0)


def ecef_to_lat_lon(xyz: np.ndarray) -> tuple[float, float]:
    x, y, z = xyz
    a = 6378137.0
    e2 = 6.69437999014e-3
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1.0 - e2))
    for _ in range(8):
        n = a / math.sqrt(1.0 - e2 * math.sin(lat) ** 2)
        lat = math.atan2(z + e2 * n * math.sin(lat), p)
    return lat, lon


def enu_error(solution_ecef: Iterable[float], truth_ecef_m: np.ndarray) -> tuple[float, float, float]:
    dx = np.array(solution_ecef, dtype=float) - truth_ecef_m
    lat, lon = ecef_to_lat_lon(truth_ecef_m)
    slat, clat = math.sin(lat), math.cos(lat)
    slon, clon = math.sin(lon), math.cos(lon)
    rot = np.array(
        [
            [-slon, clon, 0.0],
            [-slat * clon, -slat * slon, clat],
            [clat * clon, clat * slon, slat],
        ]
    )
    east, north, up = rot @ dx
    return float(east), float(north), float(up)


def obs_epoch_tow(epoch: sidereon.ObsEpochTime) -> float:
    return DAY_START_TOW + epoch.hour * 3600.0 + epoch.minute * 60.0 + epoch.second


def time_label(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S GPST")


def tow_label(tow_s: float) -> str:
    sec = tow_s - DAY_START_TOW
    whole = int(sec)
    return time_label(datetime(2026, 7, 8, tzinfo=timezone.utc) + timedelta(seconds=whole))


def bare_sat_id(sat_id: str) -> str:
    return sat_id.split(":", 1)[0]


def read_observation_files(spec: StationSpec) -> list[sidereon.RinexObs]:
    obs = []
    for path in sorted(RAW.glob(f"{spec.archive_prefix}_2026189*_15M_01S_MO.crx.gz")):
        text = sidereon.load_crinex(gzip.decompress(path.read_bytes()))
        obs.append(sidereon.parse_rinex_obs(text))
    if not obs:
        raise RuntimeError(f"no observation files for {spec.marker}")
    return obs


def if_comb(first_value: float, first_frequency: float, second_value: float, second_frequency: float) -> float:
    return (
        first_frequency * first_frequency * first_value - second_frequency * second_frequency * second_value
    ) / (first_frequency * first_frequency - second_frequency * second_frequency)


def observed_satellite_set(obs_files: list[sidereon.RinexObs]) -> set[str]:
    sats = set()
    for obs in obs_files:
        for idx in range(obs.epoch_count):
            epoch_time = obs.epoch(idx).epoch
            tow = obs_epoch_tow(epoch_time)
            if START_TOW <= tow <= END_TOW:
                for sat in obs.epoch(idx).satellites:
                    if sat.startswith(("G", "E")):
                        sats.add(sat)
    return sats


def usable_satellite_set(nav: sidereon.BroadcastEphemeris, obs_files: list[sidereon.RinexObs], step_s: int) -> list[str]:
    candidates = sorted(observed_satellite_set(obs_files))
    sample_tows = list(np.arange(START_TOW, END_TOW + step_s, step_s, dtype=float))
    usable = []
    for sat in candidates:
        ok = True
        for tow in sample_tows:
            t_j2000 = WEEK_START_J2000 + tow
            batch = sidereon.observable_states_at_j2000_s(nav, [sat], np.array([t_j2000], dtype=float))
            if batch.statuses[0] != sidereon.ObservableStateElementStatus.VALID:
                ok = False
                break
        if ok:
            usable.append(sat)
    return usable


def build_raw_epochs(obs_files: list[sidereon.RinexObs], step_s: int, allowed_sats: set[str]) -> tuple[list[RawEpoch], np.ndarray]:
    rows: list[RawEpoch] = []
    approx_positions = []
    last_tow = None
    for obs in obs_files:
        if obs.header.approx_position_m is not None:
            approx_positions.append(np.array(obs.header.approx_position_m, dtype=float))
        for idx in range(obs.epoch_count):
            epoch_time = obs.epoch(idx).epoch
            tow = obs_epoch_tow(epoch_time)
            if tow < START_TOW or tow > END_TOW:
                continue
            epoch_multiple = (tow - START_TOW) / step_s
            if abs(epoch_multiple - math.floor(epoch_multiple + 0.5)) > 1e-6:
                continue
            if last_tow is not None and abs(tow - last_tow) < 1e-6:
                continue
            values = obs.observation_values(idx)
            by_sat: dict[str, dict[str, tuple[float, float]]] = {}
            for sat, code, value, lli in zip(values.satellites, values.codes, values.values, values.lli):
                if sat not in allowed_sats or sat[0] not in SIGNAL_PAIRS or not math.isfinite(float(value)):
                    continue
                lli_value = float(lli) if math.isfinite(float(lli)) else 0.0
                by_sat.setdefault(sat, {})[code] = (float(value), lli_value)
            filtered: dict[str, dict[str, tuple[float, float]]] = {}
            for sat, sat_rows in by_sat.items():
                pair = SIGNAL_PAIRS[sat[0]]
                if all(str(pair[key]) in sat_rows for key in ("c1", "l1", "c2", "l2")):
                    filtered[sat] = sat_rows
            if len(filtered) < 6:
                continue
            jd = sidereon.split_julian_date(
                epoch_time.year, epoch_time.month, epoch_time.day, epoch_time.hour, epoch_time.minute, epoch_time.second
            )
            j2000 = sidereon.j2000_seconds(
                epoch_time.year, epoch_time.month, epoch_time.day, epoch_time.hour, epoch_time.minute, epoch_time.second
            )
            civil = sidereon.PppCivilDateTime(
                epoch_time.year, epoch_time.month, epoch_time.day, epoch_time.hour, epoch_time.minute, epoch_time.second
            )
            dt = datetime(
                epoch_time.year,
                epoch_time.month,
                epoch_time.day,
                epoch_time.hour,
                epoch_time.minute,
                int(epoch_time.second),
                int(math.floor((epoch_time.second - int(epoch_time.second)) * 1_000_000 + 0.5)),
                tzinfo=timezone.utc,
            )
            rows.append(RawEpoch(tow, dt, civil, jd.whole, jd.fraction, j2000, filtered))
            last_tow = tow
    rows.sort(key=lambda row: row.tow_s)
    if not rows:
        raise RuntimeError("no PPP epochs built")
    approx = approx_positions[0] if approx_positions else np.array([0.0, 0.0, 0.0], dtype=float)
    return rows, approx


def ssr_messages(path: Path) -> list[tuple[float, sidereon.SsrMessage]]:
    out = []
    for msg in sidereon.decode_rtcm_stream(path.read_bytes()).messages:
        if msg.kind != "ssr":
            continue
        ssr = sidereon.decode_ssr_message(msg.encode())
        if ssr.system not in (sidereon.GnssSystem.GPS, sidereon.GnssSystem.GALILEO):
            continue
        out.append((WEEK_START_J2000 + ssr.epoch_time_s, ssr))
    out.sort(key=lambda item: item[0])
    return out


def broadcast_batch(nav: sidereon.BroadcastEphemeris, sats: list[str], t_j2000: float) -> dict[str, tuple[np.ndarray, float]]:
    epochs = np.array([t_j2000] * len(sats), dtype=float)
    batch = sidereon.observable_states_at_j2000_s(nav, sats, epochs)
    states = {}
    for sat, status, pos, clk in zip(sats, batch.statuses, batch.positions_ecef_m, batch.clocks_s):
        if status == sidereon.ObservableStateElementStatus.VALID and np.all(np.isfinite(pos)) and math.isfinite(float(clk)):
            states[sat] = (np.array(pos, dtype=float), float(clk))
    return states


def select_record(nav: sidereon.BroadcastEphemeris, sat: str, issue: int, tow_s: float):
    candidates = [record for record in nav.records if record.satellite == sat and record.issue == issue]
    if not candidates:
        return None
    return min(candidates, key=lambda record: abs(record.toe_tow_s - tow_s))


def corrected_state(nav: sidereon.BroadcastEphemeris, store: sidereon.SsrCorrectionStore, sat: str, tow_s: float):
    orbit = store.orbit(sat)
    clock = store.clock(sat)
    if orbit is None or clock is None:
        return None
    if orbit.solution.provider_id != clock.solution.provider_id or orbit.solution.solution_id != clock.solution.solution_id:
        return None
    if orbit.iod_ssr != clock.iod_ssr:
        return None
    t_j2000 = WEEK_START_J2000 + tow_s
    if abs(t_j2000 - orbit.ref_epoch_j2000_s) > MAX_SSR_STALENESS_S:
        return None
    if abs(t_j2000 - clock.ref_epoch_j2000_s) > MAX_SSR_STALENESS_S:
        return None
    record = select_record(nav, sat, orbit.iode, tow_s)
    if record is None:
        return None
    try:
        ev = record.evaluate(tow_s)
        ev_m = record.evaluate(tow_s - 1.0)
        ev_p = record.evaluate(tow_s + 1.0)
    except Exception:
        return None
    r = np.array(ev.position_m, dtype=float)
    v = (np.array(ev_p.position_m, dtype=float) - np.array(ev_m.position_m, dtype=float)) / 2.0
    v_norm = np.linalg.norm(v)
    h = np.cross(r, v)
    h_norm = np.linalg.norm(h)
    if v_norm == 0.0 or h_norm == 0.0:
        return None
    e_a = v / v_norm
    e_c = h / h_norm
    e_r = np.cross(e_a, e_c)
    dt_orbit = t_j2000 - orbit.ref_epoch_j2000_s
    pos = r + (orbit.radial_m + orbit.radial_rate_m_s * dt_orbit) * e_r
    pos += (orbit.along_m + orbit.along_rate_m_s * dt_orbit) * e_a
    pos += (orbit.cross_m + orbit.cross_rate_m_s * dt_orbit) * e_c
    dt_clock = t_j2000 - clock.ref_epoch_j2000_s
    dclock_m = clock.c0_m + clock.c1_m_s * dt_clock + clock.c2_m_s2 * dt_clock * dt_clock
    high_rate = clock.high_rate
    if high_rate is not None and abs(t_j2000 - high_rate.ref_epoch_j2000_s) <= MAX_SSR_STALENESS_S:
        dclock_m += high_rate.c0_m
    return pos, float(ev.clock_s) + dclock_m / C_M_S


def mjd_for_date(year: int, month: int, day: int) -> int:
    a = (14 - month) // 12
    y = year + 4800 - a
    m = month + 12 * a - 3
    jdn = day + ((153 * m + 2) // 5) + 365 * y + y // 4 - y // 100 + y // 400 - 32045
    return int(jdn - 2400001)


def sp3_header(sats: list[str], epochs: list[float], interval_s: float, source_name: str) -> list[str]:
    first_tow = epochs[0]
    first_seconds = first_tow - DAY_START_TOW
    hour = int(first_seconds // 3600)
    minute = int((first_seconds % 3600) // 60)
    second = first_seconds % 60
    frac = first_seconds / 86400.0
    lines = [
        f"#cP2026  7  8 {hour:2d} {minute:2d} {second:11.8f}{len(epochs):8d} ORBIT {source_name[:5]:5s} HLM  SID",
        f"## {GPS_WEEK:4d} {first_tow:14.8f} {interval_s:14.8f} {mjd_for_date(2026, 7, 8):5d} {frac:.13f}",
    ]
    entries = sats + ["  0"] * (85 - len(sats))
    for i in range(0, 85, 17):
        chunk = "".join(f"{sat:>3s}" for sat in entries[i : i + 17])
        prefix = f"+ {len(sats):4d}   " if i == 0 else "+        "
        lines.append(prefix + chunk)
    for _ in range(5):
        lines.append("++       " + "  0" * 17)
    lines.extend(
        [
            "%c G  cc GPS ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc",
            "%c cc cc ccc ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc",
            "%f  1.2500000  1.025000000  0.00000000000  0.000000000000000",
            "%f  0.0000000  0.000000000  0.00000000000  0.000000000000000",
            "%i    0    0    0    0      0      0      0      0         0",
            "%i    0    0    0    0      0      0      0      0         0",
            f"/* generated from broadcast NAV and {source_name} corrections",
        ]
    )
    return lines


def write_sp3(
    station: str,
    nav: sidereon.BroadcastEphemeris,
    sats: list[str],
    source_name: str,
    correction_path: Path | None,
    epoch_step_s: int,
) -> tuple[Path, dict[tuple[float, str], str], list[dict[str, object]]]:
    SP3_DIR.mkdir(parents=True, exist_ok=True)
    sample_tows = list(np.arange(START_TOW - 900.0, END_TOW + 900.0 + epoch_step_s, epoch_step_s, dtype=float))
    lines = sp3_header(sats, sample_tows, float(epoch_step_s), f"{station}_{source_name}")
    correction_messages = ssr_messages(correction_path) if correction_path else []
    message_idx = 0
    store = sidereon.SsrCorrectionStore()
    status_by_tow_sat: dict[tuple[float, str], str] = {}
    coverage_rows = []
    for tow in sample_tows:
        t_j2000 = WEEK_START_J2000 + tow
        while message_idx < len(correction_messages) and correction_messages[message_idx][0] <= t_j2000:
            _, ssr = correction_messages[message_idx]
            store.ingest_ssr(ssr, GPS_WEEK, ssr.epoch_time_s, sidereon.TimeScale.GPST)
            message_idx += 1
        sec = tow - DAY_START_TOW
        hour = int(sec // 3600)
        minute = int((sec % 3600) // 60)
        second = sec % 60
        lines.append(f"*  2026  7  8 {hour:2d} {minute:2d} {second:11.8f}")
        broadcast_states = broadcast_batch(nav, sats, t_j2000)
        applied = 0
        fallback = 0
        fallback_sats = []
        for sat in sats:
            state = corrected_state(nav, store, sat, tow) if correction_path is not None else None
            if state is not None:
                status_by_tow_sat[(tow, sat)] = "corrected"
                applied += 1
            else:
                state = broadcast_states.get(sat)
                status_by_tow_sat[(tow, sat)] = "broadcast"
                fallback += 1
                fallback_sats.append(sat)
            if state is None:
                pos = np.array([0.0, 0.0, 0.0])
                clk_s = 999999.999999
            else:
                pos, clk_s = state
            lines.append(f"P{sat} {pos[0] / 1000.0:13.6f} {pos[1] / 1000.0:13.6f} {pos[2] / 1000.0:13.6f} {clk_s * 1.0e6:13.6f}")
        if START_TOW <= tow <= END_TOW:
            coverage_rows.append(
                {
                    "station": station,
                    "source": source_name,
                    "tow_s": f"{tow:.1f}",
                    "time_gpst": tow_label(tow),
                    "corrected_satellites": applied,
                    "broadcast_fallback_satellites": fallback,
                    "fallback_satellites": " ".join(fallback_sats),
                    "total_satellites": len(sats),
                }
            )
    lines.append("EOF")
    path = SP3_DIR / f"{station.lower()}_{source_name.lower()}_materialized.sp3"
    path.write_text("\n".join(lines) + "\n")
    sidereon.load_sp3(path)
    return path, status_by_tow_sat, coverage_rows


def build_bias_stores_by_epoch(correction_path: Path | None, raw_epochs: list[RawEpoch]) -> list[sidereon.SsrCorrectionStore | None]:
    if correction_path is None:
        return [None for _ in raw_epochs]
    messages = ssr_messages(correction_path)
    stores: list[sidereon.SsrCorrectionStore | None] = []
    for epoch in raw_epochs:
        store = sidereon.SsrCorrectionStore()
        for msg_j2000_s, ssr in messages:
            if msg_j2000_s > epoch.j2000_s:
                break
            store.ingest_ssr(ssr, GPS_WEEK, ssr.epoch_time_s, sidereon.TimeScale.GPST)
        stores.append(store)
    return stores


def code_bias(store: sidereon.SsrCorrectionStore | None, sat: str, signal: int) -> float | None:
    if store is None:
        return None
    try:
        value = store.code_bias(sat, signal)
    except Exception:
        return None
    return float(value) if value is not None and math.isfinite(float(value)) else None


def build_ppp_epochs(
    station: str,
    source: str,
    raw_epochs: list[RawEpoch],
    correction_path: Path | None,
) -> tuple[PppEpochBuild, list[dict[str, object]]]:
    stores = build_bias_stores_by_epoch(correction_path, raw_epochs)
    slip_counts: dict[str, int] = {}
    out_epochs = []
    observation_counts = []
    input_satellites = []
    usage_rows = []
    for raw, store in zip(raw_epochs, stores):
        observations = []
        applied_terms = 0
        missing_terms = 0
        max_abs_bias = 0.0
        for sat in sorted(raw.by_sat):
            pair = SIGNAL_PAIRS[sat[0]]
            sat_rows = raw.by_sat[sat]
            c1, l1, c2, l2 = str(pair["c1"]), str(pair["l1"]), str(pair["c2"]), str(pair["l2"])
            if int(sat_rows[l1][1]) & 1 or int(sat_rows[l2][1]) & 1:
                slip_counts[sat] = slip_counts.get(sat, 0) + 1
            b1 = code_bias(store, sat, int(pair["b1_signal"]))
            b2 = code_bias(store, sat, int(pair["b2_signal"]))
            if correction_path is not None:
                if b1 is None:
                    missing_terms += 1
                    b1 = 0.0
                else:
                    applied_terms += 1
                    max_abs_bias = max(max_abs_bias, abs(b1))
                if b2 is None:
                    missing_terms += 1
                    b2 = 0.0
                else:
                    applied_terms += 1
                    max_abs_bias = max(max_abs_bias, abs(b2))
            else:
                b1 = 0.0
                b2 = 0.0
            code_m = if_comb(sat_rows[c1][0] - b1, float(pair["f1"]), sat_rows[c2][0] - b2, float(pair["f2"]))
            lam1 = sidereon.rinex_observation_wavelength_m(pair["system"], l1, 3.04)
            lam2 = sidereon.rinex_observation_wavelength_m(pair["system"], l2, 3.04)
            phase_m = if_comb(sat_rows[l1][0] * lam1, float(pair["f1"]), sat_rows[l2][0] * lam2, float(pair["f2"]))
            if math.isfinite(code_m) and math.isfinite(phase_m):
                ambiguity_id = f"{sat}:{pair['label']}:{slip_counts.get(sat, 0)}"
                observations.append(sidereon.PppObservation(sat, ambiguity_id, code_m, phase_m, float(pair["f1"]), float(pair["f2"])))
        out_epochs.append(sidereon.PppEpoch(raw.civil, raw.jd_whole, raw.jd_fraction, raw.j2000_s, observations))
        observation_counts.append(len(observations))
        input_satellites.append([obs.satellite_id for obs in observations])
        usage_rows.append(
            {
                "station": station,
                "source": source,
                "tow_s": f"{raw.tow_s:.1f}",
                "time_gpst": time_label(raw.dt),
                "observations": len(observations),
                "selected_code_bias_terms": 0 if correction_path is None else len(observations) * 2,
                "applied_code_bias_terms": applied_terms,
                "missing_code_bias_terms": missing_terms,
                "max_abs_applied_code_bias_m": f"{max_abs_bias:.3f}",
            }
        )
    return PppEpochBuild(station, source, out_epochs, observation_counts, input_satellites), usage_rows


def spp_seed(
    station: str,
    sp3_path: Path,
    raw_epochs: list[RawEpoch],
    approx_position_m: np.ndarray,
    truth: TruthState,
) -> tuple[np.ndarray, dict[str, object]]:
    sp3 = sidereon.load_sp3(sp3_path)
    first = raw_epochs[0]
    observations = []
    for sat in sorted(first.by_sat):
        pair = SIGNAL_PAIRS[sat[0]]
        sat_rows = first.by_sat[sat]
        c1, c2 = str(pair["c1"]), str(pair["c2"])
        code_m = if_comb(sat_rows[c1][0], float(pair["f1"]), sat_rows[c2][0], float(pair["f2"]))
        if math.isfinite(code_m):
            observations.append(sidereon.SppObservation(sat, code_m))
    seed = approx_position_m
    status = "rinex_approx_fallback"
    residual_rms = ""
    try:
        config = sidereon.SppConfig(
            observations=observations,
            t_rx_j2000_s=first.j2000_s,
            t_rx_second_of_day_s=first.tow_s - DAY_START_TOW,
            day_of_year=DAY_OF_YEAR,
            initial_guess=[float(approx_position_m[0]), float(approx_position_m[1]), float(approx_position_m[2]), 0.0],
            corrections=sidereon.SppCorrections(ionosphere=False, troposphere=False),
            with_geodetic=True,
            robust=sidereon.SppRobustConfig(),
        )
        sol = sidereon.solve_spp(sp3, config, coarse_search_seeds=12)
        seed = np.array(sol.position, dtype=float)
        status = "broadcast_spp"
        if hasattr(sol, "residuals_m"):
            residual_rms = f"{sidereon.spp_residual_rms_m(sol.residuals_m):.4f}"
    except Exception as exc:
        status = f"rinex_approx_fallback:{type(exc).__name__}"
    e, n, u = enu_error(seed, truth_ecef(truth, first.dt))
    return seed, {
        "station": station,
        "seed_source": status,
        "seed_time_gpst": time_label(first.dt),
        "seed_observations": len(observations),
        "seed_x_m": f"{seed[0]:.4f}",
        "seed_y_m": f"{seed[1]:.4f}",
        "seed_z_m": f"{seed[2]:.4f}",
        "seed_horizontal_error_m": f"{math.hypot(e, n):.4f}",
        "seed_3d_error_m": f"{math.sqrt(e * e + n * n + u * u):.4f}",
        "seed_spp_residual_rms_m": residual_rms,
    }


def solve_prefixes(
    station: str,
    source: str,
    sp3_path: Path,
    build: PppEpochBuild,
    raw_epochs: list[RawEpoch],
    seed_position_m: np.ndarray,
    truth: TruthState,
    min_epochs: int,
    correction_status: dict[tuple[float, str], str],
) -> SourceResult:
    sp3 = sidereon.load_sp3(sp3_path)
    config = sidereon.PppFloatConfig(
        weights=sidereon.PppMeasurementWeights(code=1.0, phase=100.0, elevation_weighting=True),
        tropo=sidereon.PppTroposphereOptions(enabled=True, estimate_ztd=True),
        elevation_cutoff_deg=10.0,
        residual_screen=False,
    )
    options = sidereon.PppAutoInitOptions(initial_guess_position_m=seed_position_m.tolist())
    rows: list[dict[str, object]] = []
    for idx, raw in enumerate(raw_epochs):
        elapsed_s = raw.tow_s - raw_epochs[0].tow_s
        base = {
            "station": station,
            "source": source,
            "time_gpst": time_label(raw.dt),
            "tow_s": f"{raw.tow_s:.1f}",
            "elapsed_s": f"{elapsed_s:.1f}",
            "epochs_used": idx + 1,
            "observations_this_epoch": build.observation_counts[idx],
            "input_satellites": " ".join(build.input_satellites[idx]),
        }
        if idx + 1 < min_epochs:
            rows.append({**base, "status": "skipped_min_epochs"})
            continue
        try:
            sol = sidereon.solve_ppp_auto_init_float(sp3, build.epochs[: idx + 1], config, options)
            truth_xyz = truth_ecef(truth, raw.dt)
            east, north, up = enu_error(sol.position_m, truth_xyz)
            horiz = math.hypot(east, north)
            err3d = math.sqrt(east * east + north * north + up * up)
            used_bare_sats = sorted({bare_sat_id(sat) for sat in sol.used_sats})
            if source == "broadcast":
                corrected_used = []
                fallback_used = []
            else:
                corrected_used = [sat for sat in used_bare_sats if correction_status.get((raw.tow_s, sat)) == "corrected"]
                fallback_used = [sat for sat in used_bare_sats if correction_status.get((raw.tow_s, sat)) == "broadcast"]
            rows.append(
                {
                    **base,
                    "status": "ok",
                    "x_m": f"{sol.position_m[0]:.4f}",
                    "y_m": f"{sol.position_m[1]:.4f}",
                    "z_m": f"{sol.position_m[2]:.4f}",
                    "east_error_m": f"{east:.4f}",
                    "north_error_m": f"{north:.4f}",
                    "up_error_m": f"{up:.4f}",
                    "horizontal_error_m": f"{horiz:.4f}",
                    "vertical_error_m": f"{up:.4f}",
                    "abs_vertical_error_m": f"{abs(up):.4f}",
                    "error_3d_m": f"{err3d:.4f}",
                    "used_satellites": " ".join(sol.used_sats),
                    "used_corrected_satellites": " ".join(corrected_used),
                    "used_broadcast_fallback_satellites": " ".join(fallback_used),
                    "used_corrected_count": len(corrected_used),
                    "used_broadcast_fallback_count": len(fallback_used),
                    "code_rms_m": f"{sol.code_rms_m:.4f}",
                    "phase_rms_m": f"{sol.phase_rms_m:.4f}",
                    "weighted_rms_m": f"{sol.weighted_rms_m:.4f}",
                    "iterations": sol.iterations,
                    "solver_converged": sol.converged,
                }
            )
        except Exception as exc:
            rows.append({**base, "status": "solve_error", "error": repr(exc)})
    return SourceResult(station, source, rows)


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    keys = sorted({key for row in rows for key in row.keys()})
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        writer.writerows(rows)


def finite_rows(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    return [row for row in rows if row.get("status") == "ok" and "horizontal_error_m" in row]


def stay_under(rows: list[dict[str, object]], field: str, threshold: float) -> str:
    good = finite_rows(rows)
    for i, row in enumerate(good):
        tail = good[i:]
        if len(tail) >= SUSTAINED_TAIL_EPOCHS and all(float(item[field]) <= threshold for item in tail):
            return str(row["elapsed_s"])
    return "never"


def stay_under_tail_epochs(rows: list[dict[str, object]], field: str, threshold: float) -> int:
    good = finite_rows(rows)
    for i, row in enumerate(good):
        tail = good[i:]
        if len(tail) >= SUSTAINED_TAIL_EPOCHS and all(float(item[field]) <= threshold for item in tail):
            return len(tail)
    return 0


def final_stats(rows: list[dict[str, object]]) -> dict[str, str]:
    good = finite_rows(rows)
    if not good:
        return {
            "final_horizontal_m": "n/a",
            "final_3d_m": "n/a",
            "final_vertical_m": "n/a",
            "final_10min_horizontal_median_m": "n/a",
            "final_10min_3d_median_m": "n/a",
        }
    final = good[-1]
    final_elapsed = float(final["elapsed_s"])
    tail = [row for row in good if final_elapsed - float(row["elapsed_s"]) <= 600.0]
    return {
        "final_horizontal_m": str(final["horizontal_error_m"]),
        "final_3d_m": str(final["error_3d_m"]),
        "final_vertical_m": str(final["vertical_error_m"]),
        "final_10min_horizontal_median_m": f"{statistics.median(float(row['horizontal_error_m']) for row in tail):.4f}",
        "final_10min_3d_median_m": f"{statistics.median(float(row['error_3d_m']) for row in tail):.4f}",
    }


def station_summary(results: list[SourceResult]) -> list[dict[str, object]]:
    rows = []
    for result in results:
        rows.append(
            {
                "station": result.station,
                "source": result.source,
                "reach_stay_under_0_5m_horizontal_s": stay_under(result.rows, "horizontal_error_m", 0.5),
                "tail_epochs_under_0_5m_horizontal": stay_under_tail_epochs(result.rows, "horizontal_error_m", 0.5),
                "reach_stay_under_0_3m_horizontal_s": stay_under(result.rows, "horizontal_error_m", 0.3),
                "tail_epochs_under_0_3m_horizontal": stay_under_tail_epochs(result.rows, "horizontal_error_m", 0.3),
                "reach_stay_under_0_5m_3d_s": stay_under(result.rows, "error_3d_m", 0.5),
                "tail_epochs_under_0_5m_3d": stay_under_tail_epochs(result.rows, "error_3d_m", 0.5),
                "reach_stay_under_0_3m_3d_s": stay_under(result.rows, "error_3d_m", 0.3),
                "tail_epochs_under_0_3m_3d": stay_under_tail_epochs(result.rows, "error_3d_m", 0.3),
                **final_stats(result.rows),
            }
        )
    return rows


def numeric_or_none(value: object) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def cross_station_summary(summary_rows: list[dict[str, object]]) -> list[dict[str, object]]:
    rows = []
    for source in ["broadcast", "has", "igs"]:
        subset = [row for row in summary_rows if row["source"] == source]
        item: dict[str, object] = {"source": source, "station_count": len(subset)}
        for field in [
            "final_horizontal_m",
            "final_3d_m",
            "final_10min_horizontal_median_m",
            "reach_stay_under_0_5m_horizontal_s",
            "reach_stay_under_0_3m_horizontal_s",
        ]:
            vals = [numeric_or_none(row[field]) for row in subset]
            nums = [v for v in vals if v is not None]
            item[f"{field}_median"] = f"{statistics.median(nums):.4f}" if nums else "never"
            item[f"{field}_success_count"] = len(nums)
        rows.append(item)
    return rows


def satellite_set_checks(results: list[SourceResult]) -> list[dict[str, object]]:
    by_station_time: dict[tuple[str, str, str], dict[str, str]] = {}
    for result in results:
        for row in finite_rows(result.rows):
            key = (result.station, str(row["time_gpst"]), str(row["elapsed_s"]))
            by_station_time.setdefault(key, {})[result.source] = str(row["used_satellites"])
    checks = []
    for (station, time_gpst, elapsed_s), source_sets in sorted(by_station_time.items()):
        values = [source_sets.get(source, "") for source in ["broadcast", "has", "igs"]]
        checks.append(
            {
                "station": station,
                "time_gpst": time_gpst,
                "elapsed_s": elapsed_s,
                "broadcast_used_satellites": values[0],
                "has_used_satellites": values[1],
                "igs_used_satellites": values[2],
                "identical_across_sources": values[0] == values[1] == values[2],
            }
        )
    return checks


def correction_message_inventory() -> list[dict[str, object]]:
    rows = []
    for source, filename in [("has", "HAS_SSRA00EUH0_20260708_1933.rtcm3"), ("igs", "IGS_SSRA03IGS0_20260708_1933.rtcm3")]:
        counts: dict[int, int] = {}
        for msg in sidereon.decode_rtcm_stream((CORR / filename).read_bytes()).messages:
            counts[msg.message_number] = counts.get(msg.message_number, 0) + 1
        for msgnum in sorted(counts):
            rows.append({"source": source, "rtcm_message_number": msgnum, "message_count": counts[msgnum]})
    return rows


def first_epoch_bias_check(bias_usage: list[dict[str, object]]) -> None:
    igs_messages = ssr_messages(CORR / "IGS_SSRA03IGS0_20260708_1933.rtcm3")
    if any(msg_j2000_s <= WEEK_START_J2000 + START_TOW for msg_j2000_s, _ in igs_messages):
        return
    bad_rows = [
        row
        for row in bias_usage
        if row["source"] == "igs" and float(row["tow_s"]) == START_TOW and int(row["applied_code_bias_terms"]) != 0
    ]
    if bad_rows:
        raise RuntimeError("first IGS observation epoch applied code biases before any IGS SSR bias message was available")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--epoch-step-s", type=int, default=300)
    parser.add_argument("--min-epochs", type=int, default=3)
    args = parser.parse_args()

    if getattr(sidereon, "__version__", "") != "0.25.0":
        raise RuntimeError(f"expected sidereon==0.25.0, got {getattr(sidereon, '__version__', 'unknown')}")

    ensure_inputs()
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)
    nav = sidereon.load_rinex_nav(gzip.decompress((RAW / NAV_URL.rsplit("/", 1)[1]).read_bytes()))
    truth_by_station = parse_itrf_truth(DATA / "ITRF2020_GNSS.SSC.txt")
    source_specs = [
        ("broadcast", None),
        ("has", CORR / "HAS_SSRA00EUH0_20260708_1933.rtcm3"),
        ("igs", CORR / "IGS_SSRA03IGS0_20260708_1933.rtcm3"),
    ]

    all_results: list[SourceResult] = []
    all_coverage: list[dict[str, object]] = []
    all_bias_usage: list[dict[str, object]] = []
    seed_rows: list[dict[str, object]] = []

    for spec in STATIONS:
        obs_files = read_observation_files(spec)
        sats = usable_satellite_set(nav, obs_files, args.epoch_step_s)
        raw_epochs, approx_position = build_raw_epochs(obs_files, args.epoch_step_s, set(sats))
        sp3_paths: dict[str, Path] = {}
        correction_statuses: dict[str, dict[tuple[float, str], str]] = {}
        for source, corr_path in source_specs:
            sp3_path, status_by_tow_sat, coverage_rows = write_sp3(spec.marker, nav, sats, source, corr_path, args.epoch_step_s)
            sp3_paths[source] = sp3_path
            correction_statuses[source] = status_by_tow_sat
            all_coverage.extend(coverage_rows)
        seed_position, seed_row = spp_seed(spec.marker, sp3_paths["broadcast"], raw_epochs, approx_position, truth_by_station[spec.marker])
        seed_rows.append(seed_row)
        for source, corr_path in source_specs:
            build, usage = build_ppp_epochs(spec.marker, source, raw_epochs, corr_path)
            all_bias_usage.extend(usage)
            result = solve_prefixes(
                spec.marker,
                source,
                sp3_paths[source],
                build,
                raw_epochs,
                seed_position,
                truth_by_station[spec.marker],
                args.min_epochs,
                correction_statuses[source],
            )
            all_results.append(result)

    all_rows = [row for result in all_results for row in result.rows]
    first_epoch_bias_check(all_bias_usage)
    write_csv(OUT / "convergence_all.csv", all_rows)
    for result in all_results:
        write_csv(OUT / f"convergence_{result.station.lower()}_{result.source}.csv", result.rows)
    summary_rows = station_summary(all_results)
    cross_rows = cross_station_summary(summary_rows)
    sat_checks = satellite_set_checks(all_results)
    write_csv(OUT / "station_summary.csv", summary_rows)
    write_csv(OUT / "cross_station_summary.csv", cross_rows)
    write_csv(OUT / "spp_seed.csv", seed_rows)
    write_csv(OUT / "correction_coverage.csv", all_coverage)
    write_csv(OUT / "code_bias_usage.csv", all_bias_usage)
    write_csv(OUT / "satellite_set_check.csv", sat_checks)
    inventory_rows = correction_message_inventory()
    write_csv(OUT / "correction_message_inventory.csv", inventory_rows)


if __name__ == "__main__":
    main()
