// A trail: what it is like, where it goes up and down, how to get there, and a GPX file to take along.
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  accessPoints, estimatedSeconds, facts, heightAt, hikeFrom, isUnwalked, lineCredit, needsVerification, officialFacts, osmUrl, routeType,
  shortened, shortLoops, summary, website, hostOf, type Trail,
} from '../lib/trail';
import { go, isSaved, openShort, recState, route, say, selected, selectedState, shownTrail, toggleSaved, units } from '../state';
import { start } from '../recorder';
import { areaReady, mapJobs, trailParts } from '../map/tilesource';
import { fmtDistance, fmtElevation } from '../lib/format';
import { buildGpx, exportGpx, type GpxPoint } from '../lib/gpx';
import { lineLength, distance } from '../lib/geo';
import { APP_VERSION, platformLabel } from '../lib/submit';
import { platform } from '../platform';
import { Big, Blazes, Button, Empty, GoButton, Note, PageHeader, Segmented, split } from './common';
import type { ComponentChildren } from 'preact';
import type { Units } from '../lib/format';
import type { Access, ShortLoop } from '../lib/trail';
import { ElevationChart, LightLine } from './ElevationChart';
import { pickStops, progressOn, sunTimes, type Stop } from '../lib/follow';
import { highlightsIn } from '../data';
import { bboxOf, expand } from '../lib/geo';
import { Icon } from './Icon';
import type { Coord } from '../lib/polyline';

/** The trail as a GPX track: the main line with heights from its elevation profile, then any other sections. */
export function trailGpx(t: Trail): string {
  const total = lineLength(t.path), profileTotal = t.profile?.distances.at(-1) ?? 0;
  let run = 0;
  const main: GpxPoint[] = t.path.map((c, i) => {
    if (i > 0) run += distance(t.path[i - 1], c);
    const ele = t.profile && total > 0 ? heightAt(t.profile, (run / total) * profileTotal) : null;
    return { lat: c[0], lon: c[1], ele };
  });
  const same = (a: Coord[], b: Coord[]) => a.length === b.length && a[0][0] === b[0][0] && a[0][1] === b[0][1] && a.at(-1)![0] === b.at(-1)![0];
  const others = t.segments.filter((s) => !same(s, t.path));
  const tracks = [{ name: t.name, segments: [main] }];
  if (others.length) tracks.push({ name: `${t.name} (other sections)`, segments: others.map((s) => s.map((c) => ({ lat: c[0], lon: c[1], ele: null }))) });
  return buildGpx({
    creator: `Switchback ${platformLabel} ${APP_VERSION}`,
    name: t.name,
    desc: [t.area, 'Trail data © OpenStreetMap contributors, ODbL. From Switchback.'].filter(Boolean).join('. '),
    tracks,
  });
}

/** The address of a trail's page on the website (the phone apps share that, not their own inside address). */
export function trailLink(t: Trail): string {
  const base = platform.name === 'web' ? location.href.split('#')[0] : 'https://cadewardc.github.io/switchback/';
  return `${base}#/trail/${encodeURIComponent(t.region)}/${encodeURIComponent(t.id)}`;
}

async function share(t: Trail): Promise<void> {
  const how = await platform.files.shareLink(t.name, trailLink(t));
  if (how === 'copied') say('Link copied');
  else if (how === 'failed' && platform.name === 'web') say('Copy the address of this page to share it');
}

/** One plain line: is this trail's map on the device? */
function OfflineTick({ t }: { t: Trail }) {
  const job = mapJobs.value[`trail:${t.key}`];
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setReady(null);
    void areaReady(trailParts(t.bbox).slice(0, 1)).then((r) => { if (live) setReady(r); });
    return () => { live = false; };
  }, [t.key, job?.state]);
  if (job?.state === 'saving') return <p class="status-tick"><span class="spinner" />Saving map… {Math.round((job.done / Math.max(1, job.total)) * 100)}%</p>;
  if (ready) return <p class="status-tick ok"><Icon name="check" size={16} />Ready offline</p>;
  if (ready === false) return <p class="status-tick">Map not saved yet</p>;
  return null;
}

/** The main things on the way, to pin on the ridge: where the short loop turns off, the high point, and the
 *  sights and water the trail files know of along the line. Distances are metres along the trail's line. */
export async function stopsFor(t: Trail, whole: Trail, showShort: boolean): Promise<Stop[]> {
  const total = progressOn(t.path, t.path[0]).total;
  const stops: Stop[] = [];
  // where the short loop leaves the full loop and where it comes back
  if (showShort) {
    for (const short of shortLoops(whole)) {
      const off = short.line.map((c) => progressOn(t.path, c));
      const first = off.findIndex((o) => o.off > 30), last = off.length - 1 - off.slice().reverse().findIndex((o) => o.off > 30);
      if (first > 0) stops.push({ name: 'Short loop', along: off[first - 1].along, rank: 0 });
      if (first > 0 && last < off.length - 1 && off[last + 1].along - off[first - 1].along > total * 0.15) stops.push({ name: 'Rejoins', along: off[last + 1].along, rank: 4 });
    }
  }
  const p = t.profile;
  if (p && p.max - p.min >= 15) {
    const i = p.elevations.indexOf(Math.max(...p.elevations));
    const profileTotal = p.distances[p.distances.length - 1] || 1;
    stops.push({ name: 'High point', along: (p.distances[i] / profileTotal) * total, rank: 1 });
  }
  const KINDS: Record<string, [string, number]> = {
    viewpoint: ['Overlook', 2], waterfall: ['Waterfall', 2], peak: ['Summit', 2], cave: ['Cave', 3], water: ['Water', 3], shelter: ['Shelter', 5],
    campsite: ['Campsite', 6], picnic: ['Picnic', 7],
  };
  try {
    const box = bboxOf([t.path]);
    for (const h of box ? await highlightsIn(expand(box, 0.001)) : []) {
      const kind = KINDS[h.kind];
      if (!kind) continue;
      const at = progressOn(t.path, [h.lat, h.lon]);
      if (at.off > 45) continue;
      const name = h.name && h.name.length <= 16 ? h.name : kind[0];
      stops.push({ name, along: at.along, rank: kind[1] });
    }
  } catch { /* no highlights: the ridge is drawn without them */ }
  return pickStops(stops, total);
}

/** Starts recording while following a trail's line. */
export async function follow(t: Trail, stops: Stop[] = []): Promise<void> {
  if (recState.peek() !== 'idle') {
    say('A hike is already being recorded. Finish it first.');
    go({ page: 'record' });
    return;
  }
  go({ page: 'record' });
  await start({ region: t.region, id: t.id, name: t.name, path: t.path, profile: t.profile, stops, loop: t.isLoop });
}

export function TrailPage() {
  const whole = selected.value;
  const r = route.value;
  const wanted = r.page === 'trail' ? `${r.region}/${r.id}` : null;
  // the whole loop or a short one; from the trail itself or in from a trailhead
  const [shortId, setShortId] = useState('');
  const [from, setFrom] = useState(-1);
  useEffect(() => {
    // (a short loop tapped in the list opens the page already set to it)
    setShortId(openShort.peek() ?? '');
    openShort.value = null;
    setFrom(-1);
  }, [whole?.key]);
  const shorts = useMemo(() => (whole ? shortLoops(whole) : []), [whole]);
  const heads = useMemo(() => (whole ? accessPoints(whole) : []), [whole]);
  const t = useMemo(() => {
    if (!whole) return null;
    const short = shorts.find((x) => x.id === shortId);
    const base = short ? shortened(whole, short) : whole;
    return from >= 0 && heads[from] ? hikeFrom(base, heads[from]) : base;
  }, [whole, shortId, from]);
  useEffect(() => {
    shownTrail.value = t && t !== whole ? t : null;
    return () => { shownTrail.value = null; };
  }, [t]);
  const [stops, setStops] = useState<Stop[]>([]);
  useEffect(() => {
    let live = true;
    setStops([]);
    if (t && whole) void stopsFor(t, whole, !shortId && from < 0).then((x) => { if (live) setStops(x); });
    return () => { live = false; };
  }, [t]);
  if (!whole || !t || whole.key !== wanted) {
    return (
      <div class="page">
        <PageHeader back={{ page: 'explore' }} backLabel="Trails" />
        <div class="page-scroll">
          {selectedState.value === 'missing'
            ? <Empty icon="peak" title="Trail not found">This trail isn't in the current trail files. It may have been renamed or removed when the files were rebuilt.</Empty>
            : <p class="quiet-line">Loading the trail…</p>}
        </div>
      </div>
    );
  }
  const saved = isSaved(whole);
  return (
    <TrailView
      whole={whole} trail={t} shorts={shorts} shortId={shortId} heads={heads} from={from} saved={saved} units={units.value} stops={stops}
      now={new Date()} directionsUrl={(lat, lon) => platform.links.directionsUrl(lat, lon)} shareLabel={platform.name === 'web' ? 'Copy link' : 'Share'}
      gpxLabel={platform.name === 'web' ? 'Download GPX' : 'Share GPX'} status={<OfflineTick t={whole} />}
      onBack={() => go({ page: 'explore' })} onShort={setShortId} onFrom={setFrom}
      onShare={() => void share(whole)} onFollow={() => void follow(t, stops)} onGpx={() => void exportGpx(t.name, trailGpx(t))}
      onSave={() => { toggleSaved(whole); platform.haptics.tap(); say(saved ? 'Removed from Saved' : 'Saved'); }}
    />
  );
}

/** What a trail page needs: the trail (whole, and as chosen to walk), the choices, and what to do on each
 *  action. It reads nothing else, so another layout can take the same data and callbacks. */
export interface TrailViewProps {
  whole: Trail;
  /** The trail as it is being looked at: a short loop of it, or with the walk in from a trailhead. */
  trail: Trail;
  shorts: ShortLoop[];
  shortId: string;
  heads: Access[];
  /** Index into `heads`, or -1 for the trail on its own. */
  from: number;
  saved: boolean;
  units: Units;
  /** The things on the way, pinned to the ridge. */
  stops: Stop[];
  now: Date;
  directionsUrl: (lat: number, lon: number) => string;
  shareLabel: string;
  gpxLabel: string;
  /** A small status line (is the map on the device?). */
  status?: ComponentChildren;
  onBack: () => void;
  onShort: (id: string) => void;
  onFrom: (index: number) => void;
  onShare: () => void;
  onSave: () => void;
  onFollow: () => void;
  onGpx: () => void;
}

export function TrailView(props: TrailViewProps) {
  const { whole, trail: t, shorts, shortId, heads, from, saved, units: u, stops, now } = props;
  const dist = (m: number) => fmtDistance(m, u), elev = (m: number) => fmtElevation(m, u);
  const p = t.profile;
  const head = heads[from >= 0 ? from : 0];
  const to = head?.point ?? t.start;
  const walkIns = heads.some((h) => h.line.length > 1 && h.distance >= 15);
  const unwalked = isUnwalked(whole), unverified = needsVerification(whole);
  const details = facts(t, dist), official = officialFacts(t, dist);
  const site = website(t), osm = osmUrl(t), about = summary(t);
  const blaze = (whole.tags['switchback:blaze'] ?? '').toLowerCase().split(/[\s;,/]+/)[0];
  const seconds = estimatedSeconds(t);
  const time = seconds >= 3600 ? { value: `${Math.floor(seconds / 3600)}:${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}`, unit: 'h' }
    : { value: String(Math.max(1, Math.round(seconds / 60))), unit: 'min' };
  const sun = sunTimes(now, t.start);
  const length = split(dist(t.length)), climb = split(elev(p?.gain ?? 0));
  return (
    <div class="page">
      <header class="page-header">
        <button type="button" class="btn btn-quiet back" onClick={props.onBack}><Icon name="back" size={18} /><span>Trails</span></button>
        <div class="page-actions">
          <Button kind="quiet" icon="link" aria-label={`${props.shareLabel}: this trail`} title={props.shareLabel} onClick={props.onShare} />
          <button type="button" class={`btn btn-quiet btn-icon${saved ? ' saved-on' : ''}`} aria-pressed={saved}
            aria-label={saved ? 'Remove from saved trails' : 'Save this trail'} title={saved ? 'Saved' : 'Save'} onClick={props.onSave}>
            <Icon name="bookmark" size={18} filled={saved} />
          </button>
        </div>
      </header>
      <div class="page-scroll trail-page">
        <div class="trail-head">
          <h1 class="page-title">{t.name}</h1>
          <p class="trail-area">
            <Blazes difficulty={t.difficulty} tags={whole.tags} inline />
            <span>{[t.area, blaze ? `${blaze} blazes` : null].filter(Boolean).join(' · ') || routeType(t)}</span>
          </p>
        </div>

        {shorts.length > 0 && (
          <Segmented label="Route" value={shortId} onChange={props.onShort}
            options={[{ value: '', label: `Full loop · ${dist(whole.length)}` }, ...shorts.map((x) => ({ value: x.id, label: `${x.name} · ${dist(x.length)}` }))]} />
        )}

        <Big items={[
          { value: length.value, unit: length.unit, label: 'Distance' },
          { value: p ? climb.value : '–', unit: p ? climb.unit : '', label: 'Climb' },
          { value: time.value, unit: time.unit, label: 'Easy pace' },
        ]} />

        {(p && p.distances.length > 1) || sun ? (
          <div class="card ridge-card">
            {p && p.distances.length > 1 && <ElevationChart profile={p} path={t.path} stops={stops} />}
            <LightLine now={now} back={new Date(now.getTime() + seconds * 1000)} sunset={sun?.sunset ?? null} />
          </div>
        ) : null}

        {unwalked || unverified
          ? <GoButton onClick={props.onFollow}>I walked this: record it</GoButton>
          : <GoButton onClick={props.onFollow}>Start hike</GoButton>}

        {props.status}

        {unwalked && (
          <Note kind="warn">
            <strong>Not yet walked.</strong>{' '}
            {about ?? "This trail was placed on the map from the park's own trail list and USGS lidar; nobody has sent in a walk of it yet."}
            {' '}If you walk it, record it and send it in.
          </Note>
        )}
        {unverified && (
          <Note kind="warn">
            <strong>Needs verification.</strong> This is probably a trail, but it has not been checked well enough to list as a hike.
            {whole.tags['switchback:why'] ? ` Still unsure: ${whole.tags['switchback:why']}.` : ''} If you walk it, record it and send it in.
          </Note>
        )}

        <div class="badges">
          <span class="tag"><Icon name={t.isLoop ? 'loop' : 'oneway'} size={14} />{routeType(t)}</span>
          {unverified && <span class="tag tag-warn">Needs verification</span>}
          {unwalked && <span class="tag tag-warn">Not yet walked</span>}
          {t.tags['switchback:multiuse'] === 'yes' && <span class="tag">Shared with bikes</span>}
          {!t.isHike && !unverified && <span class="tag">{t.tags['switchback:unnamed'] === 'yes' ? 'Unnamed path' : t.tags['switchback:roadwalk'] === 'yes' ? 'Road walk' : 'Side trail'}</span>}
        </div>

        {p && (
          <div class="stats">
            <div class="stat"><span class="stat-value">{elev(p.loss)}</span><span class="stat-label">Descent</span></div>
            <div class="stat"><span class="stat-value">{elev(p.max)}</span><span class="stat-label">Highest point</span></div>
            <div class="stat"><span class="stat-value">{elev(p.min)}</span><span class="stat-label">Lowest point</span></div>
          </div>
        )}

        <div class="actions">
          <Button icon="directions" href={props.directionsUrl(to[0], to[1])} data-directions={`${to[0]},${to[1]}`}>Directions</Button>
          <Button icon="download" onClick={props.onGpx}>{props.gpxLabel}</Button>
        </div>

        {about && !unwalked && <p class="about-text">{about}</p>}

        {heads.length > 0 && (
          <section>
            <h2 class="section-title">Where to start</h2>
            <div class="choice" style={{ marginTop: '12px' }}>
              {walkIns && (
                <label class="select">
                  <span class="visually-hidden">Start from</span>
                  <select value={String(from)} onChange={(e) => props.onFrom(Number((e.currentTarget as HTMLSelectElement).value))}>
                    <option value="-1">The trail on its own</option>
                    {heads.map((h, i) => h.line.length > 1 && (
                      <option value={String(i)}>From {h.name} ({h.distance < 15 ? 'on the trail' : `${dist(h.distance)} walk in`})</option>
                    ))}
                  </select>
                </label>
              )}
              {from >= 0 && <p class="fine">The distance, climb, ridge and GPX above include the walk in from {heads[from]?.name}{whole.isLoop ? ' and back out' : ''}.</p>}
              <ul class="list card">
                {heads.slice(0, 4).map((h) => (
                  <li>
                    <a class="row" href={props.directionsUrl(h.point[0], h.point[1])} data-directions={`${h.point[0]},${h.point[1]}`} target="_blank" rel="noopener">
                      <span class="row-icon"><Icon name="flag" size={18} /></span>
                      <span class="row-main">
                        <span class="row-title">{h.name}</span>
                        <span class="row-sub">{h.distance < 15 ? 'On the trail' : `${dist(h.distance)} walk to the trail`}</span>
                      </span>
                      <span class="row-action">Directions</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {official.length > 0 && (
          <section>
            <h2 class="section-title">Official record</h2>
            <dl class="facts card" style={{ marginTop: '12px' }}>
              {official.map((f) => (
                <div><dt>{f.title}</dt><dd>{f.href ? <a href={f.href} target="_blank" rel="noopener">{f.value} <Icon name="external" size={13} /></a> : f.value}</dd></div>
              ))}
            </dl>
          </section>
        )}

        {details.length > 0 && (
          <section>
            <h2 class="section-title">Details</h2>
            <dl class="facts card" style={{ marginTop: '12px' }}>
              {details.map((f) => <div><dt>{f.title}</dt><dd>{f.value}</dd></div>)}
            </dl>
          </section>
        )}

        {(site || osm) && (
          <div class="link-row">
            {site && <a href={site} target="_blank" rel="noopener">{hostOf(site)} <Icon name="external" size={13} /></a>}
            {osm && <a href={osm} target="_blank" rel="noopener">View on OpenStreetMap <Icon name="external" size={13} /></a>}
          </div>
        )}

        <p class="fine">
          {lineCredit(t)} Elevation from open terrain data. Difficulty and time are estimates worked out from
          length and climb: check conditions before you go.
        </p>
      </div>
    </div>
  );
}
