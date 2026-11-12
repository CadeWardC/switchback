// Activity: the walks you have recorded, and one walk with its map, numbers and files.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { go, route, say, sheet, storageFailed, units, walks, flyTo } from '../state';
import { shownLines } from '../map/map';
import { fmtClock, fmtDate, fmtDistance, fmtElevation } from '../lib/format';
import { buildGpx, exportGpx, type GpxPoint } from '../lib/gpx';
import { APP_VERSION } from '../lib/submit';
import { bboxOf, distance } from '../lib/geo';
import { profileOf } from '../lib/trail';
import type { Walk } from '../lib/storage';
import type { Coord } from '../lib/polyline';
import { isPhone } from '../layout';
import { Button, Empty, Note, PageHeader, Stat, dist } from './common';
import { ElevationChart } from './ElevationChart';
import { Icon } from './Icon';
import { SubmitDialog } from './SubmitDialog';

export function Activity() {
  const list = walks.value;
  return (
    <div class="page">
      <div class="page-top">
        <h1 class="page-title">Activity</h1>
      </div>
      <div class="page-scroll">
        {storageFailed.value && <Note kind="warn">This browser isn't keeping your walks (private browsing, or storage is full). Download GPX files to keep them.</Note>}
        {list.length ? (
          <ul class="list card">
            {list.map((w) => (
              <li key={w.id}>
                <button type="button" class="row" onClick={() => go({ page: 'walk', id: w.id })}>
                  <span class="row-icon"><Icon name="activity" size={18} /></span>
                  <span class="row-main">
                    <span class="row-title">{w.name}</span>
                    <span class="row-sub">{fmtDate(w.started)} · {dist(w.length)} · {fmtClock(w.seconds)}</span>
                  </span>
                  <Icon name="chevron" size={16} class="row-chevron" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon="activity" title="No walks yet">
            Walks you record are kept here, on this device.
            <div class="empty-action"><Button kind="primary" icon="record" onClick={() => go({ page: 'record' })}>Record a walk</Button></div>
          </Empty>
        )}
      </div>
    </div>
  );
}

function walkGpx(w: Walk): string {
  return buildGpx({
    creator: `Switchback Web ${APP_VERSION}`, name: w.name, time: w.started,
    tracks: [{ name: w.name, segments: w.segments.map((s) => s.map((p): GpxPoint => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.t }))) }],
  });
}

export function WalkPage() {
  const r = route.value;
  const w = walks.value.find((x) => r.page === 'walk' && x.id === r.id);
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const flat = useMemo(() => (w ? w.segments.flat() : []), [w?.id]);
  const path = useMemo(() => flat.map((p) => [p.lat, p.lon] as Coord), [flat]);
  // heights, when the device gave them for most points
  const profile = useMemo(() => {
    const withEle = flat.filter((p) => p.ele != null);
    if (withEle.length < 10 || withEle.length < flat.length * 0.8) return null;
    const ds: number[] = [], es: number[] = [];
    let run = 0;
    flat.forEach((p, i) => {
      if (i > 0) run += distance([flat[i - 1].lat, flat[i - 1].lon], [p.lat, p.lon]);
      if (p.ele != null) { ds.push(run); es.push(p.ele); }
    });
    // phone heights jump about: smooth over five points, and ignore wiggles under 5 m
    const smooth = es.map((_, i) => { const a = es.slice(Math.max(0, i - 2), i + 3); return a.reduce((x, y) => x + y, 0) / a.length; });
    return profileOf(ds, smooth, 5);
  }, [flat]);

  useEffect(() => {
    if (!w) return;
    shownLines.value = w.segments.map((s) => s.map((p) => [p.lat, p.lon] as Coord));
    if (isPhone()) sheet.value = 'half';
    const box = bboxOf([path]);
    if (box) flyTo.value = { bounds: box, zoom: 16 };
    return () => { shownLines.value = []; };
  }, [w?.id]);

  if (!w) {
    return (
      <div class="page">
        <PageHeader back={{ page: 'activity' }} backLabel="Activity" />
        <div class="page-scroll"><Empty icon="activity" title="Walk not found">It may have been deleted, or recorded in another browser.</Empty></div>
      </div>
    );
  }
  const rename = (name: string) => { walks.value = walks.value.map((x) => (x.id === w.id ? { ...x, name } : x)); };
  const imperial = units.value === 'imperial';
  const per = w.length > 50 ? w.seconds / (w.length / (imperial ? 1609.344 : 1000)) : 0;
  return (
    <div class="page">
      <PageHeader back={{ page: 'activity' }} backLabel="Activity" />
      <div class="page-scroll">
        <label class="field title-field">
          <span>Name</span>
          <input type="text" value={w.name} maxLength={80} onInput={(e) => rename((e.currentTarget as HTMLInputElement).value)}
            onBlur={(e) => { if (!(e.currentTarget as HTMLInputElement).value.trim()) rename('Walk'); }} />
        </label>
        <p class="trail-area">{new Date(w.started).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>
        <div class="stats">
          <Stat icon="length" label="Distance" value={dist(w.length)} />
          <Stat icon="clock" label="Time" value={fmtClock(w.seconds)} />
          <Stat icon="activity" label={`Minutes per ${imperial ? 'mile' : 'km'}`} value={per ? `${Math.floor(per / 60)}:${String(Math.round(per % 60)).padStart(2, '0')}` : '–'} />
          {profile && <Stat icon="climb" label="Climb" value={fmtElevation(profile.gain, units.value)} />}
        </div>
        {profile && path.length > 1 && <div class="card pad"><ElevationChart profile={profile} path={path} /></div>}
        <div class="actions">
          <Button kind="primary" icon="download" onClick={() => void exportGpx(w.name, walkGpx(w))}>Download GPX</Button>
          <Button icon="send" onClick={() => setSubmitting(true)}>Submit this trail</Button>
        </div>
        <p class="fine">
          Walked a trail that isn't on the map? Submit it and it can be added for everyone once it has been checked.
          {' '}{flat.length.toLocaleString()} points recorded, {fmtDistance(w.length, units.value)}.
        </p>
        {!confirm
          ? <Button kind="quiet" icon="trash" onClick={() => setConfirm(true)}>Delete this walk</Button>
          : (
            <div class="confirm" role="alertdialog" aria-label="Confirm">
              <span>Delete this walk for good?</span>
              <Button kind="quiet" onClick={() => setConfirm(false)}>Keep</Button>
              <Button kind="danger" onClick={() => { walks.value = walks.value.filter((x) => x.id !== w.id); say('Walk deleted'); go({ page: 'activity' }); }}>Delete</Button>
            </div>
          )}
      </div>
      {submitting && (
        <SubmitDialog onClose={() => setSubmitting(false)}
          what={{ name: w.name, kind: 'walked', length: w.length, points: flat.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.t })) }} />
      )}
    </div>
  );
}
