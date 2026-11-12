// A trail: what it is like, where it goes up and down, how to get there, and a GPX file to take along.
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  accessPoints, estimatedSeconds, facts, heightAt, hikeFrom, isUnwalked, lineCredit, needsVerification, officialFacts, osmUrl, routeType,
  shortened, shortLoops, summary, website, hostOf, type Trail,
} from '../lib/trail';
import { go, isSaved, recState, route, say, selected, selectedState, shownTrail, toggleSaved, units } from '../state';
import { start } from '../recorder';
import { areaReady, mapJobs, trailParts } from '../map/tilesource';
import { Note, Segmented } from './common';
import { fmtDistance, fmtDuration, fmtElevation } from '../lib/format';
import { buildGpx, exportGpx, type GpxPoint } from '../lib/gpx';
import { lineLength, distance } from '../lib/geo';
import { APP_VERSION, platformLabel } from '../lib/submit';
import { platform } from '../platform';
import { Badge, Button, Empty, PageHeader, Stat } from './common';
import type { ComponentChildren } from 'preact';
import type { Units } from '../lib/format';
import type { Access, ShortLoop } from '../lib/trail';
import { ElevationChart } from './ElevationChart';
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

/** Starts recording while following a trail's line. */
export async function follow(t: Trail): Promise<void> {
  if (recState.peek() !== 'idle') {
    say('A recording is already under way. Finish it first.');
    go({ page: 'record' });
    return;
  }
  go({ page: 'record' });
  await start({ region: t.region, id: t.id, name: t.name, path: t.path, profile: t.profile });
}

export function TrailPage() {
  const whole = selected.value;
  const r = route.value;
  const wanted = r.page === 'trail' ? `${r.region}/${r.id}` : null;
  // the whole loop or a short one; from the trail itself or in from a trailhead
  const [shortId, setShortId] = useState('');
  const [from, setFrom] = useState(-1);
  useEffect(() => { setShortId(''); setFrom(-1); }, [whole?.key]);
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
      whole={whole} trail={t} shorts={shorts} shortId={shortId} heads={heads} from={from} saved={saved} units={units.value}
      directionsUrl={(lat, lon) => platform.links.directionsUrl(lat, lon)} shareLabel={platform.name === 'web' ? 'Copy link' : 'Share'}
      gpxLabel={platform.name === 'web' ? 'Download GPX' : 'Share GPX'} status={<OfflineTick t={whole} />}
      onBack={() => go({ page: 'explore' })} onShort={setShortId} onFrom={setFrom}
      onShare={() => void share(whole)} onFollow={() => void follow(t)} onGpx={() => void exportGpx(t.name, trailGpx(t))}
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
  const { whole, trail: t, shorts, shortId, heads, from, saved, units: u } = props;
  const setShortId = props.onShort, setFrom = props.onFrom;
  const dist = (m: number) => fmtDistance(m, u), elev = (m: number) => fmtElevation(m, u);
  const fmt = dist;
  const p = t.profile;
  const head = heads[from >= 0 ? from : 0];
  const to = head?.point ?? t.start;
  const walkIns = heads.some((h) => h.line.length > 1 && h.distance >= 15);
  const unwalked = isUnwalked(whole), unverified = needsVerification(whole);
  const details = facts(t, fmt), official = officialFacts(t, fmt);
  const site = website(t), osm = osmUrl(t), about = summary(t);
  return (
    <div class="page">
      <header class="page-header">
        <button type="button" class="btn btn-quiet back" onClick={props.onBack}><Icon name="back" size={18} /><span>Trails</span></button>
        <div class="page-actions">
        <Button kind="quiet" icon="link" aria-label={`${props.shareLabel}: this trail`} title={props.shareLabel} onClick={props.onShare} />
        <button type="button" class={`btn btn-quiet btn-icon${saved ? ' saved-on' : ''}`} aria-pressed={saved}
          aria-label={saved ? 'Remove from saved trails' : 'Save this trail'} title={saved ? 'Saved' : 'Save'}
          onClick={props.onSave}>
          <Icon name="bookmark" size={18} filled={saved} />
        </button>
        </div>
      </header>
      <div class="page-scroll trail-page">
        <div class="trail-head">
          <h1 class="page-title">{t.name}</h1>
          {t.area && <p class="trail-area">{t.area}</p>}
          <div class="badges">
            <Badge difficulty={t.difficulty} />
            <span class="tag"><Icon name={t.isLoop ? 'loop' : 'oneway'} size={14} />{routeType(t)}</span>
            {t.tags['switchback:multiuse'] === 'yes' && <span class="tag">Shared with bikes</span>}
            {unverified && <span class="tag tag-warn">Needs verification</span>}
            {unwalked && <span class="tag tag-warn">Not yet walked</span>}
            {!t.isHike && !unverified && <span class="tag">{t.tags['switchback:unnamed'] === 'yes' ? 'Unnamed path' : t.tags['switchback:roadwalk'] === 'yes' ? 'Road walk' : 'Side trail'}</span>}
          </div>
          {props.status}
        </div>

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

        {shorts.length > 0 && (
          <div class="choice">
            <Segmented label="Route" value={shortId} onChange={setShortId}
              options={[{ value: '', label: `Full loop · ${dist(whole.length)}` }, ...shorts.map((x) => ({ value: x.id, label: `${x.name} · ${dist(x.length)}` }))]} />
            <p class="fine">The short loop takes a cut-across and skips part of the trail.</p>
          </div>
        )}

        <div class="stats">
          <Stat icon="length" label="Length" value={dist(t.length)} />
          <Stat icon="clock" label="Time, easy pace" value={fmtDuration(estimatedSeconds(t))} />
          {p && <Stat icon="climb" label="Climb" value={elev(p.gain)} />}
          {p && <Stat icon="descent" label="Descent" value={elev(p.loss)} />}
          {p && <Stat icon="peak" label="Highest point" value={elev(p.max)} />}
          {p && <Stat icon="flag" label="Lowest point" value={elev(p.min)} />}
        </div>

        {p && p.distances.length > 1 && <div class="card pad"><ElevationChart profile={p} path={t.path} /></div>}

        <div class="actions stack">
          {(unwalked || unverified) && <Button kind="primary" icon="record" onClick={props.onFollow}>I walked this: record it</Button>}
          <Button kind={unwalked || unverified ? 'secondary' : 'primary'} icon="directions" href={props.directionsUrl(to[0], to[1])} data-directions={`${to[0]},${to[1]}`}>Directions to trailhead</Button>
          {!unwalked && !unverified && <Button icon="play" onClick={props.onFollow}>Start this hike</Button>}
          <Button icon="download" onClick={props.onGpx}>{props.gpxLabel}</Button>
        </div>

        {about && !unwalked && <p class="about-text">{about}</p>}

        {heads.length > 0 && (
          <section>
            <h2 class="section-title">Where to start</h2>
            {walkIns && (
              <label class="select">
                <span class="visually-hidden">Start from</span>
                <select value={String(from)} onChange={(e) => setFrom(Number((e.currentTarget as HTMLSelectElement).value))}>
                  <option value="-1">The trail on its own</option>
                  {heads.map((h, i) => h.line.length > 1 && (
                    <option value={String(i)}>From {h.name} ({h.distance < 15 ? 'on the trail' : `${dist(h.distance)} walk in`})</option>
                  ))}
                </select>
              </label>
            )}
            {from >= 0 && <p class="fine">The length, climb, chart and GPX above include the walk in from {heads[from]?.name}{whole.isLoop ? ' and back out' : ''}.</p>}
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
          </section>
        )}

        {official.length > 0 && (
          <section>
            <h2 class="section-title">Official record</h2>
            <dl class="facts card">
              {official.map((f) => (
                <div><dt>{f.title}</dt><dd>{f.href ? <a href={f.href} target="_blank" rel="noopener">{f.value} <Icon name="external" size={13} /></a> : f.value}</dd></div>
              ))}
            </dl>
          </section>
        )}

        {details.length > 0 && (
          <section>
            <h2 class="section-title">Details</h2>
            <dl class="facts card">
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
