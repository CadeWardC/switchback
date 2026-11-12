// Saved: bookmarked trails and the routes you have drawn. Planning a route starts here.
import { go, planEditing, planName, planPoints, plannedRoutes, savedTrails, storageFailed } from '../state';
import { Button, Empty, Note, TrailRow, dist } from './common';
import { Icon } from './Icon';
import { fmtDate } from '../lib/format';
import { newId, type PlannedRoute } from '../lib/storage';
import { readGpx } from '../lib/gpximport';
import { say } from '../state';

export function openPlanned(r: PlannedRoute): void {
  planPoints.value = r.points;
  planName.value = r.name;
  planEditing.value = r.id;
  go({ page: 'plan' });
}

export function newPlan(): void {
  if (planEditing.peek()) {
    planPoints.value = [];
    planName.value = '';
    planEditing.value = null;
  }
  go({ page: 'plan' });
}

/** A GPX file from the device becomes one of your routes (to look at, follow or change). */
async function importGpx(file: File | undefined): Promise<void> {
  if (!file) return;
  const got = readGpx(await file.text().catch(() => ''), file.name);
  if (!got) { say("That file couldn't be read as GPX."); return; }
  const r: PlannedRoute = { id: newId(), name: got.name, points: got.points, length: got.length, created: Date.now() };
  plannedRoutes.value = [r, ...plannedRoutes.peek()];
  openPlanned(r);
  say('Imported');
}

export function Saved() {
  const trails = savedTrails.value, routes = plannedRoutes.value;
  return (
    <div class="page">
      <div class="page-top">
        <h1 class="page-title">Saved</h1>
      </div>
      <div class="page-scroll">
        {storageFailed.value && <Note kind="warn">This browser isn't keeping what you save (private browsing, or storage is full). Download GPX files to keep your routes.</Note>}
        <button type="button" class="feature" onClick={newPlan}>
          <span class="feature-icon"><Icon name="route" size={22} /></span>
          <span class="row-main">
            <span class="row-title">Plan a route</span>
            <span class="row-sub">Tap points on the map, see the length, take it along as GPX</span>
          </span>
          <Icon name="chevron" size={16} class="row-chevron" />
        </button>

        <button type="button" class="feature" onClick={() => go({ page: 'help' })}>
          <span class="feature-icon feature-icon-green"><Icon name="flag" size={22} /></span>
          <span class="row-main">
            <span class="row-title">Help map trails</span>
            <span class="row-sub">Trails that parks name but the map is missing, and ones that need checking</span>
          </span>
          <Icon name="chevron" size={16} class="row-chevron" />
        </button>

        <h2 class="section-title">Trails</h2>
        {trails.length ? (
          <ul class="list card">
            {trails.map((t) => <li key={`${t.region}/${t.id}`}><TrailRow t={t} extra={t.area ?? undefined} /></li>)}
          </ul>
        ) : (
          <Empty icon="bookmark" title="No saved trails yet">Open a trail and tap the bookmark to keep it here.</Empty>
        )}

        <h2 class="section-title">Your routes</h2>
        {routes.length ? (
          <ul class="list card">
            {routes.map((r) => (
              <li key={r.id}>
                <button type="button" class="row" onClick={() => openPlanned(r)}>
                  <span class="row-icon"><Icon name="route" size={18} /></span>
                  <span class="row-main">
                    <span class="row-title">{r.name}</span>
                    <span class="row-sub">{dist(r.length)} · {fmtDate(r.created)}</span>
                  </span>
                  <Icon name="chevron" size={16} class="row-chevron" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p class="quiet-line">Routes you draw, save or import appear here.</p>
        )}
        <label class="btn btn-secondary btn-wide file-pick">
          <Icon name="send" size={18} /><span>Import a GPX file</span>
          <input type="file" accept=".gpx,.xml,.txt,application/gpx+xml,application/xml,text/xml" class="visually-hidden"
            onChange={(e) => { const el = e.currentTarget as HTMLInputElement; void importGpx(el.files?.[0]); el.value = ''; }} />
        </label>
        <div class="spacer" />
        <Button kind="quiet" icon="map" onClick={() => go({ page: 'explore' })}>Find trails on the map</Button>
      </div>
    </div>
  );
}
