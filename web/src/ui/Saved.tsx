// Saved: bookmarked trails and the routes you have drawn. Planning a route starts here.
import { go, planEditing, planName, planPoints, plannedRoutes, savedTrails, storageFailed } from '../state';
import { Button, Empty, Note, TrailRow, dist } from './common';
import { Icon } from './Icon';
import { fmtDate } from '../lib/format';
import type { PlannedRoute } from '../lib/storage';

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
          <p class="quiet-line">Routes you draw and save appear here.</p>
        )}
        <div class="spacer" />
        <Button kind="quiet" icon="map" onClick={() => go({ page: 'explore' })}>Find trails on the map</Button>
      </div>
    </div>
  );
}
