// Record a walk: start, pause, finish. The line draws on the map as you go. When a trail is being followed:
// how far is left, the climb left, when you will arrive against today's sunset, where you are on its
// elevation chart, a warning when you leave it, and "Head back" along your own track.
import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  flyTo, following, go, offTrail, recAccuracy, recError, recLength, recMarkers, recSeconds, recSegments, recState, recWakeLock, say, sheet, units,
} from '../state';
import { discard, dropMarker, finish, headBack, MAX_ACCURACY, pause, resume, start, stopFollowing } from '../recorder';
import { platform } from '../platform';
import { fmtClock, fmtDistance, fmtElevation } from '../lib/format';
import { climbLeft, progressOn, secondsLeft, sunTimes } from '../lib/follow';
import { isPhone } from '../layout';
import { Button, Note } from './common';
import { ElevationChart } from './ElevationChart';
import { Icon } from './Icon';
import { myLocation } from '../map/map';

function pace(seconds: number, metres: number, imperial: boolean): string {
  if (metres < 50 || seconds < 10) return '–';
  const per = seconds / (metres / (imperial ? 1609.344 : 1000));
  if (per > 5999) return '–';
  return `${Math.floor(per / 60)}:${String(Math.round(per % 60)).padStart(2, '0')}`;
}

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Where you are, in numbers, to read out or send to someone. Needs no signal. */
export function Coordinates() {
  const me = myLocation.value;
  const u = units.value;
  if (!me) return null;
  const at = `${me.at[0].toFixed(5)}, ${me.at[1].toFixed(5)}`;
  const share = async () => {
    const text = `My location: ${at} (within about ${fmtDistance(me.accuracy, u)}${me.ele != null ? `, elevation ${fmtElevation(me.ele, u)}` : ''}). `
      + `https://www.google.com/maps?q=${me.at[0].toFixed(5)},${me.at[1].toFixed(5)}`;
    const how = await platform.files.shareText(text);
    if (how === 'copied') say('Location copied');
    else if (how === 'failed' && platform.name === 'web') say(at);
  };
  return (
    <div class="card pad coords">
      <div class="coords-text">
        <strong>{at}</strong>
        <span>
          {me.ele != null ? `Elevation ${fmtElevation(me.ele, u)} · ` : ''}good to about {fmtDistance(me.accuracy, u)}
        </span>
      </div>
      <Button icon={platform.name === 'web' ? 'link' : 'send'} aria-label={platform.name === 'web' ? 'Copy my location' : 'Share my location'}
        title={platform.name === 'web' ? 'Copy my location' : 'Share my location'} onClick={() => void share()} />
    </div>
  );
}

function Follow() {
  const f = following.value!;
  const u = units.value;
  const last = recSegments.value.at(-1)?.at(-1) ?? null;
  const [along, setAlong] = useState<number | null>(null);
  const total = useMemo(() => progressOn(f.path, f.path[0]).total, [f]);
  useEffect(() => {
    if (last) setAlong((was) => progressOn(f.path, [last.lat, last.lon], was ?? -Infinity).along);
  }, [last?.t, f]);
  useEffect(() => setAlong(null), [f]);

  const left = Math.max(0, total - (along ?? 0));
  const profileTotal = f.profile?.distances.at(-1) ?? 0;
  const onChart = f.profile && along != null && total > 0 ? (along / total) * profileTotal : null;
  const climb = f.profile ? climbLeft(f.profile, onChart ?? 0) : 0;
  const arrive = new Date(Date.now() + secondsLeft(left, climb, recLength.value, recSeconds.value) * 1000);
  const sun = sunTimes(new Date(), f.path[0]);
  const late = !!sun && arrive > sun.sunset;
  return (
    <>
      {offTrail.value && (
        <div class="banner" role="alert"><Icon name="info" size={20} /><span>You have left the trail. Check the map.</span></div>
      )}
      <div class="card pad follow-card">
        <div class="follow-name">
          <span>{f.id ? `Following ${f.name}` : f.name}</span>
          <button type="button" class="link" onClick={stopFollowing}>Stop following</button>
        </div>
        <div class="mini-stats">
          <div><strong>{fmtDistance(left, u)}</strong><span>Left to go</span></div>
          {f.profile && <div><strong>{fmtElevation(climb, u)}</strong><span>Climb left</span></div>}
          <div class={late ? 'late' : ''}><strong>{clock(arrive)}</strong><span>{late ? 'Arrive, after sunset' : 'Arrive, at your pace'}</span></div>
          {sun && <div><strong>{clock(sun.sunset)}</strong><span>Sunset today</span></div>}
        </div>
        {f.profile && f.profile.distances.length > 1 && <ElevationChart profile={f.profile} path={f.path} here={onChart} />}
      </div>
    </>
  );
}

export function Record() {
  const [confirm, setConfirm] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markName, setMarkName] = useState('');
  const state = recState.value;
  const imperial = units.value === 'imperial';
  const background = platform.location.recordsInBackground;

  useEffect(() => { if (isPhone()) sheet.value = 'half'; }, []);

  // keep the newest point on screen while recording
  const newest = recSegments.value.at(-1)?.at(-1);
  useEffect(() => {
    if (state === 'recording' && newest) flyTo.value = { center: [newest.lat, newest.lon], zoom: 16 };
  }, [state, newest?.t]);

  const done = async () => {
    const walk = await finish();
    if (walk) go({ page: 'walk', id: walk.id });
    else { setConfirm(false); say('Nothing was recorded, so there is no walk to keep.'); }
  };
  const mark = (e: Event) => {
    e.preventDefault();
    if (dropMarker(markName)) say('Marked');
    else say('No position yet, so nothing was marked.');
    setMarking(false);
    setMarkName('');
  };
  const acc = recAccuracy.value;
  const hasTrack = recSegments.value.some((s) => s.length > 1);

  return (
    <div class="page">
      <div class="page-top">
        <h1 class="page-title">{state === 'idle' ? 'Record a walk' : state === 'recording' ? 'Recording' : 'Paused'}</h1>
      </div>
      <div class="page-scroll">
        <div class="rec-stats" aria-live="off">
          <div><span class="rec-value">{fmtClock(recSeconds.value)}</span><span class="rec-label">Time</span></div>
          <div><span class="rec-value">{fmtDistance(recLength.value, units.value)}</span><span class="rec-label">Distance</span></div>
          <div><span class="rec-value">{pace(recSeconds.value, recLength.value, imperial)}</span><span class="rec-label">Min per {imperial ? 'mile' : 'km'}</span></div>
        </div>

        {state === 'idle' && <Button kind="primary" icon="play" wide class="btn-big" onClick={() => void start()}>Start</Button>}
        {state === 'recording' && (
          <div class="actions">
            <Button icon="pause" class="btn-big" onClick={() => void pause()}>Pause</Button>
            <Button kind="primary" icon="stop" class="btn-big" onClick={() => void done()}>Finish</Button>
          </div>
        )}
        {state === 'paused' && (
          <div class="actions">
            <Button icon="play" class="btn-big" onClick={() => void resume()}>Resume</Button>
            <Button kind="primary" icon="stop" class="btn-big" onClick={() => void done()}>Finish</Button>
          </div>
        )}

        {recError.value && (
          <Note kind="warn">
            {recError.value}
            {platform.name !== 'web' && /allowed/.test(recError.value) && <> <button type="button" class="link" onClick={() => platform.links.openSettings()}>Open Settings</button></>}
          </Note>
        )}
        {state === 'recording' && !recError.value && (
          <p class="status-line">
            <span class={`signal ${acc == null ? 'wait' : acc <= 15 ? 'good' : acc <= MAX_ACCURACY ? 'ok' : 'bad'}`} aria-hidden="true" />
            {acc == null ? 'Finding your position…'
              : acc <= MAX_ACCURACY ? `Position good to about ${fmtDistance(acc, units.value)}`
              : `Position is too rough right now (about ${fmtDistance(acc, units.value)}), so these points are left out`}
          </p>
        )}

        {state !== 'idle' && following.value && <Follow />}

        {state !== 'idle' && (
          <>
            {!marking ? (
              <div class="actions">
                <Button icon="flag" onClick={() => setMarking(true)}>Mark this spot</Button>
                <Button icon="undo" disabled={!hasTrack || following.value?.name === 'Back to the start'}
                  onClick={() => { if (headBack()) say('Following your own track back to the start'); }}>Head back</Button>
              </div>
            ) : (
              <form class="inline-form" onSubmit={mark}>
                <input type="text" value={markName} maxLength={60} placeholder="Name it: spring, junction, view" aria-label="Name for this spot" autoFocus
                  onInput={(e) => setMarkName((e.currentTarget as HTMLInputElement).value)} />
                <Button kind="primary" type="submit">Mark</Button>
                <Button kind="quiet" aria-label="Cancel" icon="close" onClick={() => setMarking(false)} />
              </form>
            )}
            {recMarkers.value.length > 0 && (
              <p class="quiet-line">{recMarkers.value.length} {recMarkers.value.length === 1 ? 'spot' : 'spots'} marked: {recMarkers.value.map((m) => m.name).join(', ')}</p>
            )}
          </>
        )}

        <Coordinates />

        {state === 'paused' && (!confirm
          ? <Button kind="quiet" icon="trash" onClick={() => setConfirm(true)}>Discard this walk</Button>
          : (
            <div class="confirm" role="alertdialog" aria-label="Confirm">
              <span>Throw this walk away?</span>
              <Button kind="quiet" onClick={() => setConfirm(false)}>Keep</Button>
              <Button kind="danger" onClick={() => { void discard(); setConfirm(false); }}>Discard</Button>
            </div>
          ))}

        {background ? (
          state === 'idle' && <Note>Recording carries on with the screen off and the phone in your pocket. It needs no signal: GPS works anywhere under open sky.</Note>
        ) : (
          <Note kind={state === 'recording' && recWakeLock.value === 'unsupported' ? 'warn' : 'info'}>
            {state === 'recording' && recWakeLock.value === 'unsupported'
              ? 'This browser can\'t keep the screen on by itself. Recording stops whenever the screen turns off or you switch apps, so keep this page open and the screen awake.'
              : 'In a web browser, recording only works while this page is open and the screen is on. The screen is kept awake while you record. The Switchback phone apps keep recording in your pocket.'}
          </Note>
        )}
        {state === 'idle' && <Button kind="quiet" icon="activity" onClick={() => go({ page: 'activity' })}>Your recorded walks</Button>}
      </div>
    </div>
  );
}
