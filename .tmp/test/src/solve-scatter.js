const DEG = Math.PI / 180;
export function ecefDeltaToEnuM(stationLatDeg, stationLonDeg, deltaM) {
    const lat = stationLatDeg * DEG;
    const lon = stationLonDeg * DEG;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon);
    const cosLon = Math.cos(lon);
    const [dx, dy, dz] = deltaM;
    return [
        -sinLon * dx + cosLon * dy,
        -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz,
        cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz,
    ];
}
export function buildSolveScatterPoints(fixes, activeKey, truthEcefM, stationLatDeg, stationLonDeg) {
    return fixes.map((fix) => {
        const delta = [
            fix.positionM[0] - truthEcefM[0],
            fix.positionM[1] - truthEcefM[1],
            fix.positionM[2] - truthEcefM[2],
        ];
        const [eastM, northM, upM] = ecefDeltaToEnuM(stationLatDeg, stationLonDeg, delta);
        return {
            key: fix.key,
            label: fix.label,
            eastM,
            northM,
            upM,
            errorM: Math.hypot(delta[0], delta[1], delta[2]),
            active: fix.key === activeKey,
        };
    });
}
export function beginSolveScatterTransition(previous, next, startedAtMs, durationMs = 520) {
    const byKey = new Map(previous.map((point) => [point.key, point]));
    return {
        startedAtMs,
        durationMs,
        points: next.map((target) => {
            const start = byKey.get(target.key) ?? target;
            return {
                key: target.key,
                label: target.label,
                fromEastM: start.eastM,
                fromNorthM: start.northM,
                fromUpM: start.upM,
                toEastM: target.eastM,
                toNorthM: target.northM,
                toUpM: target.upM,
                fromActive: start.active,
                toActive: target.active,
                errorM: target.errorM,
            };
        }),
    };
}
export function interpolateSolveScatterTransition(transition, nowMs) {
    const rawT = transition.durationMs <= 0 ? 1 : (nowMs - transition.startedAtMs) / transition.durationMs;
    const t = Math.max(0, Math.min(1, rawT));
    const eased = 1 - Math.pow(1 - t, 3);
    return transition.points.map((point) => ({
        key: point.key,
        label: point.label,
        eastM: point.fromEastM + (point.toEastM - point.fromEastM) * eased,
        northM: point.fromNorthM + (point.toNorthM - point.fromNorthM) * eased,
        upM: point.fromUpM + (point.toUpM - point.fromUpM) * eased,
        errorM: point.errorM,
        active: t >= 0.5 ? point.toActive : point.fromActive,
    }));
}
