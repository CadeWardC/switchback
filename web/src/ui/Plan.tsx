// Plan a route: tap the map to add points, drag them to adjust, save it, take it along as GPX.
import { useEffect, useState } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import { planEditing, planName, planPoints, plannedRoutes, say, sheet, go } from '../state';
import { planTap } from '../map/map';
import { lineLength } from '../lib/geo';
import { buildGpx, exportGpx } from '../lib/gpx';
import { APP_VERSION, platformLabel } from '../lib/submit';
import { newId } from '../lib/storage';
import { platform } from '../platform';
import { isPhone } from '../layout';
import { Button, Note, PageHeader, dist } from './common';
import { SubmitDialog } from './SubmitDialog';
import { fmtDuration } from '../lib/format';

export function Plan() {
  const [submitting, setSubmitting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const length = useComputed(() => lineLength(planPoints.value));
  const points = planPoints.value;

  useEffect(() => {
    planTap.value = (c) => {
      planPoints.value = [...planPoints.peek(), [+c[0].toFixed(6), +c[1].toFixed(6)]];
      platform.haptics.tap();
    };
    if (isPhone()) sheet.value = 'peek';
    return () => { planTap.value = null; };
  }, []);

  const name = planName.value.trim() || 'My route';
  const gpx = () => buildGpx({
    creator: `Switchback ${platformLabel} ${APP_VERSION}`, name,
    desc: 'A route drawn on the map with Switchback (straight lines between points).',
    tracks: [{ name, segments: [points.map((c) => ({ lat: c[0], lon: c[1] }))] }],
  });
  const saveRoute = () => {
    const id = planEditing.value ?? newId();
    const prior = plannedRoutes.value.find((r) => r.id === id);
    const saved = { id, name, points, length: length.value, created: prior?.created ?? Date.now() };
    plannedRoutes.value = [saved, ...plannedRoutes.value.filter((r) => r.id !== id)];
    planEditing.value = id;
    planName.value = name;
    say('Route saved');
  };
  const remove = () => {
    const id = planEditing.value;
    if (id) plannedRoutes.value = plannedRoutes.value.filter((r) => r.id !== id);
    planPoints.value = [];
    planName.value = '';
    planEditing.value = null;
    setConfirmClear(false);
    if (id) { say('Route deleted'); go({ page: 'saved' }); }
  };

  return (
    <div class="page">
      <PageHeader back={{ page: 'saved' }} backLabel="Saved">
        <p class="plan-length" aria-live="polite">
          <strong>{dist(length.value)}</strong>
          <span>{points.length} {points.length === 1 ? 'point' : 'points'}{length.value > 0 ? ` · about ${fmtDuration(length.value / 1000 / 4.5 * 3600)}` : ''}</span>
        </p>
      </PageHeader>
      <div class="page-scroll">
        <h1 class="visually-hidden">Plan a route</h1>
        <div class="actions three">
          <Button icon="undo" disabled={!points.length} onClick={() => (planPoints.value = points.slice(0, -1))}>Undo</Button>
          <Button icon="trash" disabled={!points.length && !planEditing.value} onClick={() => setConfirmClear(true)}>{planEditing.value ? 'Delete' : 'Clear'}</Button>
          <Button kind="primary" icon="check" disabled={points.length < 2} onClick={saveRoute}>Save</Button>
        </div>
        {confirmClear && (
          <div class="confirm" role="alertdialog" aria-label="Confirm">
            <span>{planEditing.value ? 'Delete this saved route?' : 'Remove every point?'}</span>
            <Button kind="quiet" onClick={() => setConfirmClear(false)}>Keep</Button>
            <Button kind="danger" onClick={remove}>{planEditing.value ? 'Delete' : 'Clear'}</Button>
          </div>
        )}
        {points.length < 2 && (
          <Note>Tap the map to add points. Drag a point to move it. Lines run straight between points, so add more points on bends.</Note>
        )}
        <label class="field">
          <span>Name</span>
          <input type="text" value={planName.value} maxLength={80} placeholder="My route"
            onInput={(e) => (planName.value = (e.currentTarget as HTMLInputElement).value)} />
        </label>
        <div class="actions">
          <Button icon="download" disabled={points.length < 2} onClick={() => void exportGpx(name, gpx())}>Download GPX</Button>
          <Button icon="send" disabled={points.length < 2} onClick={() => setSubmitting(true)}>Submit this trail</Button>
        </div>
        <p class="fine">Routes are kept in this browser only. The length follows the straight lines you draw, so a winding path is a little longer on the ground.</p>
      </div>
      {submitting && (
        <SubmitDialog onClose={() => setSubmitting(false)}
          what={{ name, kind: 'placed', length: length.value, points: points.map((c) => ({ lat: c[0], lon: c[1] })) }} />
      )}
    </div>
  );
}
