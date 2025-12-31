// Axial Hex Coordinate System logic
// q = x, r = z (cube coords)

export const HEX_SIZE = 30;

export function getHexGrid(radius) {
    let hexes = [];
    for (let q = -radius; q <= radius; q++) {
        let r1 = Math.max(-radius, -q - radius);
        let r2 = Math.min(radius, -q + radius);
        for (let r = r1; r <= r2; r++) {
            hexes.push({ q, r, s: -q-r });
        }
    }
    return hexes;
}

export function hexToPixel(hex, size = HEX_SIZE) {
    const x = size * (Math.sqrt(3) * hex.q + Math.sqrt(3)/2 * hex.r);
    const y = size * (3./2 * hex.r);
    return { x, y };
}

export function pixelToHex(x, y, size = HEX_SIZE) {
    const q = (Math.sqrt(3)/3 * x - 1./3 * y) / size;
    const r = (2./3 * y) / size;
    return roundHex({ q, r, s: -q-r });
}

export function roundHex(hex) {
    let rq = Math.round(hex.q);
    let rr = Math.round(hex.r);
    let rs = Math.round(hex.s);

    const q_diff = Math.abs(rq - hex.q);
    const r_diff = Math.abs(rr - hex.r);
    const s_diff = Math.abs(rs - hex.s);

    if (q_diff > r_diff && q_diff > s_diff) {
        rq = -rr - rs;
    } else if (r_diff > s_diff) {
        rr = -rq - rs;
    } else {
        rs = -rq - rr;
    }
    return { q: rq, r: rr, s: rs };
}

export function hexDistance(a, b) {
    return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

export function getNeighbors(hex) {
    const directions = [
        {q: 1, r: 0}, {q: 1, r: -1}, {q: 0, r: -1},
        {q: -1, r: 0}, {q: -1, r: 1}, {q: 0, r: 1}
    ];
    return directions.map(d => ({ q: hex.q + d.q, r: hex.r + d.r, s: - (hex.q + d.q) - (hex.r + d.r) }));
}

export function getKey(hex) {
    return `${hex.q},${hex.r}`;
}