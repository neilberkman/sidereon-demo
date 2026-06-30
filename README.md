# sidereon · marketing site

The landing site for **sidereon**: one reference-validated GNSS and astrodynamics
engine, built as a single Rust core with first-class interfaces in Rust, Python,
C, Elixir, and WebAssembly/JavaScript. The site is about the library and its
polyglot reach. The in-browser solver is one showcase section, not the thesis.

The headline differentiator is the multi-language story. The same validated math
is reachable as idiomatic code in every ecosystem, including the BEAM, where no
serious GNSS library has existed before.

## Install

| Language | Install | Registry |
| --- | --- | --- |
| Rust | `cargo add sidereon` | crates.io/crates/sidereon |
| Python | `pip install sidereon` | pypi.org/project/sidereon |
| Elixir | `{:sidereon, "~> 0.8"}` in `mix.exs` | hex.pm/packages/sidereon |
| JavaScript / WASM | `npm i @neilberkman/sidereon` | npmjs.com/package/@neilberkman/sidereon |
| C | link `libsidereon` + the cbindgen header | github.com/neilberkman/sidereon |

Primary repo: https://github.com/neilberkman/sidereon

## Page structure

1. **Hero** — the featured live constellation globe behind the message: one engine,
   five languages, with a compact install switcher and the GitHub call to action.
2. **Language interfaces** — the same capability (propagate a TLE, or load an SP3
   and run an SPP solve) as real code in Rust / Python / C / Elixir / JavaScript,
   tabbed by language and capability, each with its install line and registry link.
3. **Capabilities** — the engine's breadth: SPP, RTK, PPP, SGP4, frames and time
   (IAU), IONEX, RINEX, conjunction screening (CDM/OMM), ANTEX, DOP, RF link budget.
4. **Validation** — reference-validated against SGP4 (Vallado/CelesTrak), frames
   (Skyfield/IAU), positioning (real IGS products), and IERS Earth orientation.
5. **Live** — the WASM interface running client-side in the tab: the constellation
   globe, an in-browser SPP solve, an observer skyplot, and a global IONEX TEC map.
   Every panel has a maximize control that opens it fullscreen with the full detail
   and the underlying calculations. After the initial asset load there are zero
   server calls.
6. **Footer** — GitHub, registry links, MIT license, and data attribution.

The code snippets in the interfaces section are drawn from the real public APIs of
the sibling repos (`sidereon`, `sidereon-python`, `sidereon-c`, `sidereon-ex`,
`sidereon-wasm`) and live in `src/snippets.ts`.

## The live section

Everything below the fold in the live section is the `sidereon` Rust core compiled
to WebAssembly and executed in the page. The SPP solve loads a real SP3 precise
ephemeris (CNES/CLS GRG final) and a committed pseudorange fixture and runs the
engine's least-squares solver in the tab, twice: raw (geometry + satellite clock)
and corrected (broadcast Klobuchar L1 ionosphere + Saastamoinen troposphere). The
"NET 0" pill asserts on screen that no network calls happen after load. The
constellation comes from real CelesTrak element sets propagated by the engine's
SGP4; ground tracks run through the validated TEME → GCRS → ITRS frame pipeline.
The IONEX panel renders a real global vertical-TEC field and a representative slant
delay; it is a standalone exhibit and is not fed into the SPP solve.

## Bundled real data

All inputs live in `public/data/` and are the exact bytes the engine consumes.
`scripts/fetch-data.mjs` refreshes the TLEs and the global IONEX at build time
(one provider fetch per build, runtime stays zero-network), and records the TLE
epoch in `data-manifest.json` so the constellation panel can show its age.

| File | What it is |
| --- | --- |
| `GRG0MGXFIN_20201760000_01D_15M_ORB.SP3` | CNES/CLS GRG final multi-GNSS precise orbits, 2020 DOY 176, 15-min. |
| `spp_fixture.json` | SPP trace fixture: 30 GPS L1 pseudoranges, fixed receiver truth, Klobuchar + surface-met fields, full iteration trace. |
| `global.ionex` | A global IONEX vertical-TEC map (AIUB/CODE). |
| `gps-ops.tle`, `galileo.tle`, `glo-ops.tle`, `beidou.tle` | Real CelesTrak element sets. |
| `land110.json` | Natural Earth land polygons for coastlines. |

## Build and run

Requires Node 18+ and the locally built `sidereon-wasm` package (referenced via
`file:../sidereon-wasm/pkg` in `package.json`).

```
npm install
npm run dev       # vite dev server at http://localhost:5173
npm run build     # refresh data, then production build to dist/
npm run preview   # serve the production build
```

`scripts/shoot.mjs` drives Playwright to capture the section screenshots under
`screenshots/` and to assert zero console errors and that the net pill stays
"NET 0".

Data attribution: CelesTrak, IGS / CODE, AIUB, IERS, Natural Earth.
MIT licensed.
