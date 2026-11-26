# sidereon · marketing site

The landing site for **sidereon**, a GNSS and astrodynamics engine with
interfaces in Rust, Python, C, Go, Elixir, and JavaScript.

## Install

| Language | Install | Registry |
| --- | --- | --- |
| Rust | `cargo add sidereon` | crates.io/crates/sidereon |
| Python | `pip install sidereon` | pypi.org/project/sidereon |
| Elixir | `{:sidereon, "~> 4.2"}` in `mix.exs` | hex.pm/packages/sidereon |
| JavaScript / WASM | `npm i @neilberkman/sidereon` | npmjs.com/package/@neilberkman/sidereon |
| Go | `go get sidereon.dev/go/v4` | pkg.go.dev/sidereon.dev/go/v4 |
| C | link `libsidereon` + the cbindgen header | github.com/neilberkman/sidereon-c |

Primary repo: https://github.com/neilberkman/sidereon

## Page structure

1. **Hero** — the live constellation globe, install switcher, and GitHub link.
2. **Live** — a constellation globe, SPP and RTK positioning, an observer
   skyplot, an IONEX TEC map, GNSS attitude, and track cleanup. Expand the attitude
   panel to inspect individual yaw samples.
3. **Astrodynamics lab** — visibility coverage, conjunction screening, and
   orbit recovery from three positions.
4. **Language interfaces** — TLE propagation, SP3 positioning, and broadcast
   GNSS attitude examples in all six languages.
5. **Capabilities** — positioning, navigation formats, time and frames, force
   models, orbit propagation and fitting, and event prediction.
6. **Validation** — comparisons with published references, including Orekit
   astrodynamics models, IGS orbit products, and Vallado SGP4 vectors.
7. **Footer** — GitHub, registry links, MIT license, and data attribution.

## The live section

After the initial asset load there are zero server calls. The SPP panel solves from ABMF pseudoranges and broadcast navigation records.
The correction selector enables broadcast Klobuchar ionosphere and Saastamoinen
troposphere corrections. The constellation uses CelesTrak element sets, and its
ground tracks follow the TEME → GCRS → ITRS frame pipeline. The IONEX panel shows
vertical TEC and a representative slant delay.

The GNSS attitude panel shows yaw, nominal yaw, and Sun elevation for one GPS
satellite on 2026-06-24 UTC, with the active yaw mode marked along the time axis.
The ABMF navigation file covers part of the day. The panel extrapolates one
broadcast fit per satellite across the day and uses the default TDB Earth
orientation for the trajectory. The expanded view lists UTC and TDB epochs,
yaw, nominal yaw, Sun elevation, and mode.

## Bundled real data

The panels use data bundled with the site.
The scheduled `refresh-tle` workflow (twice daily) is the only thing that talks
to the providers: CelesTrak group files, with a per-group Space-Track (18 SDS)
fallback that keeps the CelesTrak name lines, a 2-hour guard so no group is
fetched more often than CelesTrak updates it, and a stop on 403/404. Builds and
visitors never fetch; they use the committed files and `tle-refresh.json`
(refresh time and source per group). `npm run fetch-data` is a manual local
refresh under the same 2-hour guard.

| File | What it is |
| --- | --- |
| `abmf_obs.rnx` | IGS ABMF RINEX observations for the SPP exhibit. |
| `abmf_nav.rnx` | IGS ABMF RINEX navigation records from 2026-06-24 for SPP and GNSS attitude. |
| `global.ionex` | A global IONEX vertical-TEC map (AIUB/CODE). |
| `gps-ops.tle`, `galileo.tle`, `glo-ops.tle`, `beidou.tle` | Real CelesTrak element sets. |
| `land110.json` | Natural Earth land polygons for coastlines. |

## Build and run

Requires Node `^20.19.0 || >=22.12.0` and the published
`@neilberkman/sidereon` WASM package.

```
npm install
npm run dev
npm run build
npm run preview
```

`scripts/shoot.mjs` drives Playwright to capture the section screenshots under
`screenshots/` and to assert zero console errors and that the net pill stays
"NET 0".

Data attribution: CelesTrak, IGS / CODE, AIUB, IERS, Natural Earth.
MIT licensed.
