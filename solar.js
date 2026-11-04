// solar.js - sun geometry and facade irradiance for the site (no dependencies).
// Sun position: Cooper declination, Spencer equation of time (Duffie & Beckman, Solar Engineering of Thermal Processes, ch. 1).
// Facade irradiance: monthly-average-day method - Erbs monthly diffuse fraction, Collares-Pereira & Rabl (r_t) and
// Liu & Jordan (r_d) hourly distribution, isotropic sky, ground reflectance 0.2 - driven by NASA POWER monthly GHI.
// This is a screening estimate (no shading, no hourly weather), labelled as such wherever it is shown.
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const AVG_DAY = [17, 47, 75, 105, 135, 162, 198, 228, 258, 288, 318, 344];      // Klein's recommended average day of each month
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const ORIENTS = [["N", 0], ["NE", 45], ["E", 90], ["SE", 135], ["S", 180], ["SW", 225], ["W", 270], ["NW", 315]];

export const declination = n => 23.45 * Math.sin(D2R * 360 * (284 + n) / 365);          // degrees
export function equationOfTime(n) {                                                      // minutes
  const B = D2R * (n - 1) * 360 / 365;
  return 229.2 * (0.000075 + 0.001868 * Math.cos(B) - 0.032077 * Math.sin(B) - 0.014615 * Math.cos(2 * B) - 0.04089 * Math.sin(2 * B));
}
export const sunsetHourAngle = (lat, dec) => R2D * Math.acos(Math.max(-1, Math.min(1, -Math.tan(lat * D2R) * Math.tan(dec * D2R))));

/** Sun position for latitude (deg), declination (deg) and hour angle (deg, 0 = solar noon, negative = morning).
 *  Returns altitude (deg) and azimuth (deg clockwise from north) plus the unit vector (east, north, up). */
export function sunFromHourAngle(lat, dec, w) {
  const p = lat * D2R, d = dec * D2R, h = w * D2R;
  const up = Math.cos(p) * Math.cos(d) * Math.cos(h) + Math.sin(p) * Math.sin(d);
  const east = -Math.cos(d) * Math.sin(h);
  const north = Math.sin(d) * Math.cos(p) - Math.cos(d) * Math.sin(p) * Math.cos(h);
  return { altitude: R2D * Math.asin(Math.max(-1, Math.min(1, up))), azimuth: ((R2D * Math.atan2(east, north)) + 360) % 360, east, north, up };
}

const dayOfYear = date => Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 864e5);

/** Sun position at a real instant (Date) for a site. */
export function sunAt(date, lat, lon) {
  const n = dayOfYear(date), utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const solar = utcH + lon / 15 + equationOfTime(n) / 60;
  return { ...sunFromHourAngle(lat, declination(n), 15 * (solar - 12)), solarTime: ((solar % 24) + 24) % 24, n };
}

/** Clock time (IST, UTC+5:30) corresponding to a solar time on day n at longitude lon. */
export const istFromSolar = (solarH, n, lon) => solarH - lon / 15 - equationOfTime(n) / 60 + 5.5;

/** Sun path for one day: hourly points (solar time) with altitude > 0. */
export function sunPath(lat, n, step = 0.5) {
  const dec = declination(n), pts = [];
  for (let t = 4; t <= 20 + 1e-9; t += step) { const s = sunFromHourAngle(lat, dec, 15 * (t - 12)); if (s.altitude > 0) pts.push({ t, ...s }); }
  return pts;
}

/** Monthly-average-day irradiance on vertical facades.
 *  ghiKwh: 12 monthly mean daily GHI values (kWh/m2/day). Returns per month: daily totals by orientation (kWh/m2/day),
 *  hourly incident W/m2 by orientation (24 values), clearness index, diffuse fraction. */
export function facadeIrradiance(lat, ghiKwh, { albedo = 0.2, extra = {} } = {}) {
  const DIRS = [...ORIENTS, ...Object.entries(extra)];   // extra: {key: azimuth deg clockwise from true north}, e.g. one per BIM wall
  const Gsc = 1367, p = lat * D2R, out = [];
  for (let m = 0; m < 12; m++) {
    const n = AVG_DAY[m], dec = declination(n), d = dec * D2R;
    const ws = sunsetHourAngle(lat, dec), wsr = ws * D2R;
    const H0 = (24 * 3600 * Gsc / Math.PI) * (1 + 0.033 * Math.cos(D2R * 360 * n / 365)) *
      (Math.cos(p) * Math.cos(d) * Math.sin(wsr) + wsr * Math.sin(p) * Math.sin(d)) / 1e6;          // MJ/m2/day
    const H = ghiKwh[m] * 3.6, Kt = H / H0;
    const fd = ws <= 81.4 ? 1.391 - 3.560 * Kt + 4.189 * Kt * Kt - 2.137 * Kt ** 3 : 1.311 - 3.022 * Kt + 3.427 * Kt * Kt - 1.821 * Kt ** 3;
    const Hd = fd * H;
    const a = 0.409 + 0.5016 * Math.sin(wsr - Math.PI / 3), b = 0.6609 - 0.4767 * Math.sin(wsr - Math.PI / 3);
    const den = Math.sin(wsr) - wsr * Math.cos(wsr);
    const hourly = Object.fromEntries(DIRS.map(([o]) => [o, new Array(24).fill(0)]));
    const horiz = new Array(24).fill(0);
    let sumRt = 0;
    for (let h = 0; h < 24; h++) {
      const w = 15 * (h + 0.5 - 12), wr = w * D2R;
      if (Math.cos(wr) <= Math.cos(wsr)) continue;
      const rt = (Math.PI / 24) * (a + b * Math.cos(wr)) * (Math.cos(wr) - Math.cos(wsr)) / den;
      const rd = (Math.PI / 24) * (Math.cos(wr) - Math.cos(wsr)) / den;
      sumRt += rt;
      const I = rt * H, Id = Math.min(I, rd * Hd), Ib = Math.max(0, I - Id);                           // MJ/m2 in this hour
      const s = sunFromHourAngle(lat, dec, w);
      horiz[h] = I * 1e6 / 3600;
      for (const [o, g] of DIRS) {
        const cosT = s.east * Math.sin(g * D2R) + s.north * Math.cos(g * D2R);
        const Rb = s.up > 0.02 ? Math.max(0, cosT) / s.up : 0;
        const It = Ib * Rb + Id * 0.5 + I * albedo * 0.5;                                              // vertical: (1+cos90)/2 = (1-cos90)/2 = 0.5
        hourly[o][h] = It * 1e6 / 3600;                                                                // W/m2 averaged over the hour
      }
    }
    const daily = Object.fromEntries(DIRS.map(([o]) => [o, hourly[o].reduce((x, y) => x + y, 0) / 1000]));   // kWh/m2/day
    out.push({ month: MONTHS[m], n, Kt, diffuseFraction: fd, H0, sumRt, daily, hourly, horizontalHourly: horiz });
  }
  return out;
}

export const MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const BIN_AZ = Object.fromEntries(ORIENTS);

/** Per-wall solar exposure for a project. walls: [{id, azimuth_deg|null, orientation, area_m2, u_value}].
 *  Returns F (monthly results incl. one key per wall) and, per wall: annual kWh/m2, annual kWh on the wall. */
export function wallSolar(lat, ghiKwh, walls) {
  const extra = {};
  for (const w of walls) extra["w:" + w.id] = w.azimuth_deg != null ? w.azimuth_deg : BIN_AZ[w.orientation];
  const F = facadeIrradiance(lat, ghiKwh, { extra });
  const per = walls.map(w => {
    const k = "w:" + w.id, annual = F.reduce((t, m, i) => t + m.daily[k] * MONTH_DAYS[i], 0);
    return { wall: w, key: k, azimuth: extra[k], annual_kwh_m2: annual, annual_kwh: annual * (w.area_m2 || 0) };
  });
  return { F, per };
}

/** Steady-state solar-driven heat flux into the room through an opaque wall (W/m2):
 *  sol-air excess (alpha * I * Rse) times U. Ignores thermal mass (the time lag delays it), wind and long-wave exchange. */
export const solarHeatFlux = (u, alpha, I, rse = 0.04) => u * alpha * I * rse;
