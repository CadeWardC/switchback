// Sending in a trail.
//
// There is no server yet. For now "Submit this trail" (1) saves a submission file, exactly as
// docs/SUBMISSIONS.md describes it (the same file the iPhone and Android apps write), and (2) opens a new
// GitHub issue with the details filled in, to which the sender attaches that file.
//
// ─── EXTENSION POINT ───────────────────────────────────────────────────────────────────────────────────
// To use a real backend, replace `submitTrail` below (keep its signature). Nothing else in the site knows
// how a submission travels. Accounts, photos and reviews are deliberately not built; they would start here.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────
import { buildGpx, exportGpx, fileName, xml, type GpxPoint } from './gpx';
import { platform } from '../platform';
import { distance } from './geo';

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
export const SUBMISSION_NS = 'https://github.com/CadeWardC/switchback/submission/1';
const ISSUES = 'https://github.com/CadeWardC/switchback/issues/new';

export interface Submission {
  name: string;
  notes: string;
  /** walked: recorded on foot. drawn: points placed on the map, not walked. */
  kind: 'walked' | 'drawn';
  /** The sender says it is open to the public on foot. */
  publicAccess: boolean;
  /** Recorded points keep their time (and height when the phone gave one); drawn points have neither. */
  points: GpxPoint[];
  lengthMetres: number;
}

export interface SubmissionResult { fileName: string; issueUrl: string }

export function isLoop(points: GpxPoint[], length: number): boolean {
  if (points.length < 3 || length <= 500) return false;
  const a = points[0], b = points[points.length - 1];
  return distance([a.lat, a.lon], [b.lat, b.lon]) < Math.max(150, length * 0.03);
}

/** The submission file (docs/SUBMISSIONS.md). */
export function submissionGpx(s: Submission, now = Date.now()): string {
  const lines = [
    '      <sb:submission>',
    `        <sb:kind>${s.kind}</sb:kind>`,
    `        <sb:app>${xml(`web ${APP_VERSION}`)}</sb:app>`,
  ];
  if (isLoop(s.points, s.lengthMetres)) lines.push('        <sb:loop>yes</sb:loop>');
  if (s.publicAccess) lines.push('        <sb:access>public</sb:access>');
  lines.push('      </sb:submission>');
  const points = s.kind === 'drawn' ? s.points.map(({ lat, lon }) => ({ lat, lon })) : s.points;
  return buildGpx({
    creator: `Switchback Web ${APP_VERSION}`,
    name: s.name,
    desc: s.notes.trim() || undefined,
    time: now,
    namespaces: { sb: SUBMISSION_NS },
    metadataExtensions: lines.join('\n'),
    tracks: [{ name: s.name, segments: [points] }],
  });
}

export function issueUrl(s: Submission): string {
  const a = s.points[0], km = (s.lengthMetres / 1000).toFixed(2);
  const body = [
    `**Trail name:** ${s.name}`,
    `**How it was made:** ${s.kind === 'walked' ? 'Recorded while walking it' : 'Drawn on the map (not walked yet)'}`,
    `**Length:** ${km} km`,
    a ? `**Starts near:** ${a.lat.toFixed(5)}, ${a.lon.toFixed(5)} (https://www.openstreetmap.org/?mlat=${a.lat.toFixed(5)}&mlon=${a.lon.toFixed(5)}#map=15/${a.lat.toFixed(5)}/${a.lon.toFixed(5)})` : '',
    `**Open to the public on foot:** ${s.publicAccess ? 'Yes, as far as I know' : 'Not sure'}`,
    '',
    '**Notes:**',
    s.notes.trim() || '(none)',
    '',
    `**File:** please drag \`${fileName(s.name)}\` (it was just ${platform.files.exportVerb}) into this box to attach it. GitHub does not take .gpx files as they are: zip it first, or rename it to end in .gpx.txt.`,
    '',
    `_Sent from the Switchback website ${APP_VERSION}._`,
  ].filter((l) => l !== '').join('\n').replace(/\n\*\*Notes/, '\n\n**Notes').replace(/\n\*\*File/, '\n\n**File').replace(/\n_Sent/, '\n\n_Sent');
  const q = new URLSearchParams({ title: `Trail submission: ${s.name}`, body });
  return `${ISSUES}?${q.toString()}`;
}

/** Sends a trail in. Today: saves the file and returns the link to the prefilled issue for the caller to open. */
export async function submitTrail(s: Submission): Promise<SubmissionResult> {
  const name = fileName(s.name);
  await exportGpx(s.name, submissionGpx(s));
  return { fileName: name, issueUrl: issueUrl(s) };
}
