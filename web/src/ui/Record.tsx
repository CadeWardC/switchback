// Hike: where a hike is recorded. While walking it is one card (the ridge with you on it in yellow and the
// next thing named, two big numbers, one quiet line); pulled up, the rest: moving time, pace, climb left,
// sunset, light to spare, height now, coordinates, then Pause, Mark a spot and Finish. Finish asks once.
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  endReached, flyTo, following, go, offTrail, offTrailInfo, recAccuracy, recError, recLength, recMarkers, recSeconds, recSegments, recStarted,
  recState, recWakeLock, say, sheet, units, walks,
} from '../state';
import { discard, dropMarker, finish, headBack, keepGoing, MAX_ACCURACY, pause, resume, start, stopFollowing } from '../recorder';
import { platform } from '../platform';
import { fmtClock, fmtDistance, fmtDuration, fmtElevation } from '../lib/format';
import { climbLeft, nextStop, progressOn, secondsLeft, sunTimes } from '../lib/follow';
import { profileOf } from '../lib/trail';
import { isPhone } from '../layout';
import { Big, Button, GoButton, Note, Stat, split } from './common';
import { ElevationChart, LightLine } from './ElevationChart';
import { myLocation } from '../map/map';

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
const hm = (minutes: number) => { const m = Math.max(0, Math.round(minutes)); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`; };

function pace(seconds: number, metres: number, imperial: boolean): string {
  if (metres < 50 || seconds < 10) return '–';
  const per = seconds / (metres / (imperial ? 1609.344 : 1000));
  if (per > 5999) return '–';
  return `${Math.floor(per / 60)}:${String(Math.round(per % 60)).padStart(2, '0')}`;
}

/** Where you are, in numbers, to read out or send to someone. Needs no signal. */
export function Coordinates() {
  const me = myLocation.value;
  const u = units.value;
  if (!me) return null;
  const at = `${me.at[0].toFixed(4)}, ${me.at[1].toFixed(4)}`;
  const share = async () => {
    const text = `My location: ${me.at[0].toFixed(5)}, ${me.at[1].toFixed(5)} (within about ${fmtDistance(me.accuracy, u)}${me.ele != null ? `, elevation ${fmtElevation(me.ele, u)}` : ''}). `
      + `https://www.google.com/maps?q=${me.at[0].toFixed(5)},${me.at[1].toFixed(5)}`;
    const how = await platform.files.shareText(text);
    if (how === 'copied') say('Location copied');
    else if (how === 'failed' && platform.name === 'web') say(at);
  };
  return (
    <div class="card coords">
      <div class="coords-text">
        <strong>{at}</strong>
        <span>You are here · good to {fmtDistance(me.accuracy, u)}</span>
      </div>
      <button type="button" class="btn btn-quiet" onClick={() => void share()}>{platform.name === 'web' ? 'Copy' : 'Share'}</button>
    </div>
  );
}

/** What has been climbed so far, from the heights the device gave (smoothed: phone heights jump about). */
function climbedSoFar(): number | null {
  const es = recSegments.value.flat().map((p) => p.ele).filter((e): e is number => e != null);
  if (es.length < 10) return null;
  const smooth = es.map((_, i) => { const a = es.slice(Math.max(0, i - 2), i + 3); return a.reduce((x, y) => x + y, 0) / a.length; });
  return profileOf(smooth.map((_, i) => i), smooth, 5).gain;
}

/** The card shown when the end of the trail is reached. It asks once; ignoring it changes nothing. */
function EndCard({ onFinish }: { onFinish: () => void }) {
  const u = units.value;
  return (
    <div class="end-card" role="alertdialog" aria-labelledby="end-title">
      <h2 id="end-title">{endReached.value === 'start' ? 'You are back at the trailhead' : 'You have reached the end of the trail'}</h2>
      <p>{fmtDistance(recLength.value, u)} in {fmtDuration(recSeconds.value)}. Finish this hike?</p>
      <div class="actions">
        <Button class="btn-big" onClick={keepGoing}>Keep going</Button>
        <Button kind="primary" class="btn-big" onClick={onFinish}>Finish hike</Button>
      </div>
    </div>
  );
}

export function Record() {
  const [asking, setAsking] = useState<'finish' | 'discard' | null>(null);
  const [marking, setMarking] = useState(false);
  const [markName, setMarkName] = useState('');
  const state = recState.value;
  const u = units.value;
  const imperial = u === 'imperial';
  const f = state === 'idle' ? null : following.value;

  useEffect(() => { if (isPhone()) sheet.value = 'half'; }, [state === 'idle']);

  // keep the newest point on screen while recording
  const newest = recSegments.value.at(-1)?.at(-1) ?? null;
  useEffect(() => {
    if (state === 'recording' && newest) flyTo.value = { center: [newest.lat, newest.lon], zoom: 16 };
  }, [state, newest?.t]);

  // where you are along the trail being followed
  const total = useMemo(() => (f ? progressOn(f.path, f.path[0]).total : 0), [f]);
  const [along, setAlong] = useState<number | null>(null);
  useEffect(() => setAlong(null), [f]);
  useEffect(() => {
    if (f && newest && !offTrail.peek()) setAlong((was) => progressOn(f.path, [newest.lat, newest.lon], was ?? -Infinity).along);
  }, [newest?.t, f]);

  const done = async () => {
    const walk = await finish();
    setAsking(null);
    if (walk) go({ page: 'walk', id: walk.id });
    else say('Nothing was recorded, so there is no hike to keep.');
  };
  const mark = (e: Event) => {
    e.preventDefault();
    say(dropMarker(markName) ? 'Marked' : 'No position yet, so nothing was marked.');
    setMarking(false);
    setMarkName('');
  };

  // ── not hiking: the way in ──
  if (state === 'idle') {
    return (
      <div class="page">
        <div class="page-top"><h1 class="page-title">Hike</h1></div>
        <div class="page-scroll">
          <p class="quiet-line">
            Open a trail and press Start hike to follow it: how far is left, when you will be back, and a nudge if you leave it. Or record where you walk:
          </p>
          <GoButton onClick={() => void start()}>Start recording</GoButton>
          {recError.value && <Note kind="warn">{recError.value}</Note>}
          <Coordinates />
          {platform.location.recordsInBackground ? (
            <Note>Recording carries on with the screen off and the phone in your pocket. It needs no signal: GPS works anywhere under open sky.</Note>
          ) : (
            <Note>
              {isPhone()
                ? 'In a web browser, recording only works while this page is open and the screen is on (the screen is kept awake while you record). The Switchback phone apps keep recording in your pocket.'
                : 'A hike is recorded on a phone. Recording here works while this page is open, but the Switchback apps for iPhone and Android are made for it: they keep recording in your pocket, with no signal.'}
              {' '}<a href="#/settings">Get the app</a>
            </Note>
          )}
          {walks.value.length > 0 && <Button kind="quiet" onClick={() => go({ page: 'activity' })}>Your log: {walks.value.length} {walks.value.length === 1 ? 'hike' : 'hikes'}</Button>}
        </div>
      </div>
    );
  }

  // ── hiking ──
  const left = Math.max(0, total - (along ?? 0));
  const profileTotal = f?.profile?.distances.at(-1) ?? 0;
  const onChart = f?.profile && total > 0 ? ((along ?? 0) / total) * profileTotal : 0;
  const climbAhead = f?.profile ? climbLeft(f.profile, onChart) : 0;
  const now = new Date();
  const back = new Date(now.getTime() + secondsLeft(left, climbAhead, recLength.value, recSeconds.value) * 1000);
  const sun = sunTimes(now, newest ? [newest.lat, newest.lon] : f ? f.path[0] : myLocation.value?.at ?? [0, 0]);
  const hasPlace = !!(newest || f || myLocation.value);
  const late = !!f && !!sun && hasPlace && back > sun.sunset;
  const next = f?.stops && along != null ? nextStop(f.stops, along) : f?.stops?.[0] ?? null;
  const climbed = f?.profile ? Math.max(0, f.profile.gain - climbAhead) : climbedSoFar();
  const onTrail = recStarted.value ? (Date.now() - recStarted.value) / 1000 : recSeconds.value;
  const acc = recAccuracy.value;
  const off = offTrail.value ? offTrailInfo.value : null;
  const leftText = split(fmtDistance(left, u)), walkedText = split(fmtDistance(recLength.value, u));
  const spare = sun && hasPlace ? (sun.sunset.getTime() - (f ? back.getTime() : now.getTime())) / 60000 : null;

  return (
    <div class="page">
      <h1 class="visually-hidden">{state === 'recording' ? 'Hiking' : 'Paused'}{f ? `: ${f.name}` : ''}</h1>
      <div class="page-scroll hike">
        {endReached.value && <EndCard onFinish={() => void done()} />}

        {off && (
          <div class="now-card" role="alert">
            <span class="light-label">Off the trail</span>
            <b>{fmtDistance(off.metres, u)}<span>{off.way}</span></b>
            <p>Follow the dots back. Your own track is saved if you need to retrace it.</p>
          </div>
        )}

        {f?.profile && f.profile.distances.length > 1 && !endReached.value && (
          <div class="card ridge-card">
            {next && <p class="next-name">{next.name}<span>in {fmtDistance(Math.max(0, next.along - (along ?? 0)), u)}</span></p>}
            <ElevationChart profile={f.profile} path={f.path} stops={f.stops ?? []} here={along ?? 0} next={next} height={next || f.stops?.length ? 92 : 78} />
          </div>
        )}

        {f ? (
          <Big huge items={[
            { value: leftText.value, unit: leftText.unit, label: 'left' },
            { value: clock(back), label: late ? 'back by, after sunset' : 'back by', late },
          ]} />
        ) : (
          <Big huge items={[
            { value: walkedText.value, unit: walkedText.unit, label: 'walked' },
            { value: fmtClock(recSeconds.value), label: state === 'paused' ? 'paused' : 'moving' },
          ]} />
        )}

        <p class="hike-line">
          <span><b>{fmtClock(onTrail)}</b> on the trail</span>
          {f && <span><b>{fmtDistance(recLength.value, u)}</b> walked</span>}
          {climbed != null && <span><b>{fmtElevation(climbed, u)}</b> climbed</span>}
          {f && <span>{f.id ? f.name : 'Back to the start'}</span>}
        </p>

        {recError.value && (
          <Note kind="warn">
            {recError.value}
            {platform.name !== 'web' && /allowed/.test(recError.value) && <> <button type="button" class="link" onClick={() => platform.links.openSettings()}>Open Settings</button></>}
          </Note>
        )}
        {state === 'paused' && !recError.value && <Note>Paused. Nothing is being recorded until you resume.</Note>}

        {/* pulled up: the rest */}
        <div class="stats">
          <Stat label="Moving" value={fmtClock(recSeconds.value)} />
          <Stat label={`Pace, min/${imperial ? 'mi' : 'km'}`} value={pace(recSeconds.value, recLength.value, imperial)} />
          {f?.profile ? <Stat label="Climb left" value={fmtElevation(climbAhead, u)} /> : <Stat label="Walked" value={fmtDistance(recLength.value, u)} />}
          <Stat label="Sunset" value={sun && hasPlace ? clock(sun.sunset) : '–'} />
          <Stat label={spare != null && spare < 0 ? 'After sunset' : 'Light to spare'} value={spare != null ? hm(Math.abs(spare)) : '–'} />
          <Stat label="Height now" value={myLocation.value?.ele != null ? fmtElevation(myLocation.value.ele, u) : newest?.ele != null ? fmtElevation(newest.ele, u) : '–'} />
        </div>
        {f && sun && hasPlace && <div class="card ridge-card"><LightLine now={now} back={back} sunset={sun.sunset} started /></div>}

        <Coordinates />
        <p class="status-line">
          <span class={`signal ${state !== 'recording' || acc == null ? 'wait' : acc <= 15 ? 'good' : acc <= MAX_ACCURACY ? 'ok' : 'bad'}`} aria-hidden="true" />
          {state !== 'recording' ? 'Not recording'
            : acc == null ? 'Finding your position…'
            : acc <= MAX_ACCURACY ? `GPS good to about ${fmtDistance(acc, u)}`
            : `GPS is too rough right now (about ${fmtDistance(acc, u)}), so these points are left out`}
        </p>

        {marking ? (
          <form class="inline-form" onSubmit={mark}>
            <input type="text" value={markName} maxLength={60} placeholder="Name it: spring, junction, view" aria-label="Name for this spot" autoFocus
              onInput={(e) => setMarkName((e.currentTarget as HTMLInputElement).value)} />
            <Button kind="primary" type="submit">Mark</Button>
            <Button kind="quiet" aria-label="Cancel" icon="close" onClick={() => setMarking(false)} />
          </form>
        ) : asking === 'finish' ? (
          <div class="confirm" role="alertdialog" aria-label="Finish this hike?">
            <span>Finish this hike?</span>
            <Button onClick={() => setAsking(null)}>Not yet</Button>
            <Button kind="primary" onClick={() => void done()}>Finish</Button>
          </div>
        ) : (
          <div class="actions three">
            {state === 'recording'
              ? <Button class="btn-big" onClick={() => void pause()}>Pause</Button>
              : <Button class="btn-big" onClick={() => void resume()}>Resume</Button>}
            <Button class="btn-big" onClick={() => setMarking(true)}>Mark a spot</Button>
            <Button kind="primary" class="btn-big" onClick={() => setAsking('finish')}>Finish</Button>
          </div>
        )}
        {recMarkers.value.length > 0 && (
          <p class="quiet-line">{recMarkers.value.length} {recMarkers.value.length === 1 ? 'spot' : 'spots'} marked: {recMarkers.value.map((m) => m.name).join(', ')}</p>
        )}

        <div class="link-row">
          <button type="button" class="link" disabled={!recSegments.value.some((s) => s.length > 1) || (!!f && !f.id)}
            onClick={() => { if (headBack()) say('Following your own track back to the start'); }}>Head back the way you came</button>
          {f && <button type="button" class="link" onClick={stopFollowing}>Stop following</button>}
          {state === 'paused' && asking !== 'discard' && <button type="button" class="link" onClick={() => setAsking('discard')}>Discard this hike</button>}
        </div>
        {asking === 'discard' && (
          <div class="confirm" role="alertdialog" aria-label="Throw this hike away?">
            <span>Throw this hike away?</span>
            <Button onClick={() => setAsking(null)}>Keep</Button>
            <Button kind="danger" onClick={() => { void discard(); setAsking(null); }}>Discard</Button>
          </div>
        )}

        {!platform.location.recordsInBackground && (
          <Note kind={state === 'recording' && recWakeLock.value === 'unsupported' ? 'warn' : 'info'}>
            {state === 'recording' && recWakeLock.value === 'unsupported'
              ? 'This browser can\'t keep the screen on by itself. Recording stops whenever the screen turns off or you switch apps, so keep this page open and the screen awake.'
              : 'In a web browser, recording only works while this page is open and the screen is on. The Switchback phone apps keep recording in your pocket.'}
          </Note>
        )}
      </div>
    </div>
  );
}
