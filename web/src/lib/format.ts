export type Units = 'imperial' | 'metric';

export function defaultUnits(): Units {
  const lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  // miles and feet where they are used on trail signs
  return /-(US|GB|LR|MM)\b/i.test(lang) || lang === 'en' ? 'imperial' : 'metric';
}

const num = (v: number, digits: number) =>
  v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function fmtDistance(m: number, units: Units): string {
  if (units === 'imperial') {
    const mi = m / 1609.344;
    if (mi < 0.1) return `${num(Math.round(m * 3.28084), 0)} ft`;
    return `${num(mi, mi < 10 ? 1 : 0)} mi`;
  }
  if (m < 1000) return `${num(Math.round(m / 10) * 10, 0)} m`;
  const km = m / 1000;
  return `${num(km, km < 10 ? 1 : 0)} km`;
}

/** A height or a climb. */
export function fmtElevation(m: number, units: Units): string {
  return units === 'imperial' ? `${num(Math.round(m * 3.28084), 0)} ft` : `${num(Math.round(m), 0)} m`;
}

export function fmtDuration(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** A stopwatch: 1:02:03 or 12:34. */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
