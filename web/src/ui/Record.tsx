// Record a walk: start, pause, finish. The line draws on the map as you go.
import { useEffect, useState } from 'preact/hooks';
import { go, recAccuracy, recError, recLength, recSeconds, recState, recWakeLock, sheet, units, flyTo, recSegments } from '../state';
import { discard, finish, MAX_ACCURACY, pause, resume, start } from '../recorder';
import { platform } from '../platform';
import { fmtClock, fmtDistance } from '../lib/format';
import { isPhone } from '../layout';
import { Button, Note } from './common';
import { myLocation } from '../map/map';

function pace(seconds: number, metres: number, imperial: boolean): string {
  if (metres < 50 || seconds < 10) return '–';
  const per = seconds / (metres / (imperial ? 1609.344 : 1000));
  if (per > 5999) return '–';
  return `${Math.floor(per / 60)}:${String(Math.round(per % 60)).padStart(2, '0')}`;
}

export function Record() {
  const [confirm, setConfirm] = useState(false);
  const state = recState.value;
  const imperial = units.value === 'imperial';

  useEffect(() => { if (isPhone()) sheet.value = 'half'; }, []);

  // keep the newest point on screen while recording
  useEffect(() => {
    if (state !== 'recording') return;
    const me = myLocation.value;
    const last = recSegments.value.at(-1)?.at(-1);
    if (last && me) flyTo.value = { center: [last.lat, last.lon], zoom: 16 };
  }, [state, recSegments.value.at(-1)?.length]);

  const done = async () => {
    const walk = await finish();
    if (walk) go({ page: 'walk', id: walk.id });
    else setConfirm(false);
  };
  const acc = recAccuracy.value;

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
          <>
            <div class="actions">
              <Button icon="play" class="btn-big" onClick={() => void resume()}>Resume</Button>
              <Button kind="primary" icon="stop" class="btn-big" onClick={() => void done()}>Finish</Button>
            </div>
            {!confirm
              ? <Button kind="quiet" icon="trash" onClick={() => setConfirm(true)}>Discard this walk</Button>
              : (
                <div class="confirm" role="alertdialog" aria-label="Confirm">
                  <span>Throw this walk away?</span>
                  <Button kind="quiet" onClick={() => setConfirm(false)}>Keep</Button>
                  <Button kind="danger" onClick={() => { void discard(); setConfirm(false); }}>Discard</Button>
                </div>
              )}
          </>
        )}

        {recError.value && <Note kind="warn">{recError.value}</Note>}
        {state === 'recording' && !recError.value && (
          <p class="status-line">
            <span class={`signal ${acc == null ? 'wait' : acc <= 15 ? 'good' : acc <= MAX_ACCURACY ? 'ok' : 'bad'}`} aria-hidden="true" />
            {acc == null ? 'Finding your position…'
              : acc <= MAX_ACCURACY ? `Position good to about ${fmtDistance(acc, units.value)}`
              : `Position is too rough right now (about ${fmtDistance(acc, units.value)}), so these points are left out`}
          </p>
        )}

        {!platform.location.recordsInBackground && (
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
