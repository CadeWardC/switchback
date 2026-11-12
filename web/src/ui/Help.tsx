// Help map trails: trails a park names that the map has no line for yet, and likely trails that still
// need checking. Both are apart from the hikes: nothing here is a trail you can rely on.
import { useEffect, useState } from 'preact/hooks';
import { flyTo, go, regions, sheet, unverifiedInView, view, MIN_TRAIL_ZOOM } from '../state';
import { regionCovers } from '../lib/pack';
import { distance } from '../lib/geo';
import { wantedFor, type Wanted } from '../data';
import { isPhone } from '../layout';
import { Empty, Note, PageHeader, dist } from './common';
import { Icon } from './Icon';

const PAGE = 40;

export function Help() {
  const v = view.value;
  const [wanted, setWanted] = useState<Wanted[] | null>(null);
  const [shown, setShown] = useState(PAGE);
  // the regions under the middle of the map (or all of those in view, when zoomed in on a border)
  const here = v ? regions.value.filter((r) => regionCovers(r, [v.center[0], v.center[1], v.center[0], v.center[1]])) : [];
  const ids = (here.length ? here : v ? regions.value.filter((r) => regionCovers(r, v.bounds)).slice(0, 3) : []).map((r) => r.region).join(',');
  useEffect(() => {
    let live = true;
    setWanted(null);
    setShown(PAGE);
    void Promise.all(ids.split(',').filter(Boolean).map((id) => wantedFor(id).catch(() => [] as Wanted[])))
      .then((lists) => { if (live) setWanted(lists.flat()); });
    return () => { live = false; };
  }, [ids]);

  const c = v?.center;
  const near = (w: Wanted) => (c && w.lat != null && w.lon != null ? distance(c, [w.lat, w.lon]) : Infinity);
  const sorted = (wanted ?? []).slice().sort((a, b) => near(a) - near(b) || a.park.localeCompare(b.park));
  const unverified = (v?.zoom ?? 0) >= MIN_TRAIL_ZOOM ? unverifiedInView.value : [];
  const show = (w: Wanted) => {
    if (w.lat == null || w.lon == null) return;
    if (isPhone()) sheet.value = 'peek';
    flyTo.value = { center: [w.lat, w.lon], zoom: 14 };
  };

  return (
    <div class="page">
      <PageHeader back={{ page: 'saved' }} backLabel="Saved" title="Help map trails" />
      <div class="page-scroll">
        <Note>
          Walk a trail that is missing or unsure, record it, and send it in from Activity. Every trail is checked before it is added.
        </Note>

        <h2 class="section-title">Needs verification, on the map now</h2>
        {unverified.length ? (
          <ul class="list card">
            {unverified.map((t) => (
              <li key={t.key}>
                <button type="button" class="row" onClick={() => go({ page: 'trail', region: t.region, id: t.id })}>
                  <span class="row-icon row-icon-warn"><Icon name="route" size={18} /></span>
                  <span class="row-main">
                    <span class="row-title">{t.name}</span>
                    <span class="row-sub">{dist(t.length)}{t.area ? ` · ${t.area}` : ''}</span>
                  </span>
                  <Icon name="chevron" size={16} class="row-chevron" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p class="quiet-line">
            {(v?.zoom ?? 0) < MIN_TRAIL_ZOOM ? 'Zoom in on the map to see them. They are drawn as dashed brown lines.' : 'None on this part of the map. They are drawn as dashed brown lines.'}
          </p>
        )}

        <h2 class="section-title">Trails wanted{sorted.length ? `, nearest first (${sorted.length})` : ''}</h2>
        <p class="fine">A park's own list or map names these, but there is no line for them yet.</p>
        {wanted == null ? <p class="quiet-line">Loading…</p> : !sorted.length ? (
          <Empty icon="check" title="Nothing wanted here">No missing trails are listed for this part of the map. Move the map to another state or province.</Empty>
        ) : (
          <>
            <ul class="list card">
              {sorted.slice(0, shown).map((w) => (
                <li class="wanted">
                  <div class="row-main">
                    <span class="row-title">{w.trail}</span>
                    <span class="row-sub">
                      {w.park}{w.miles ? ` · about ${dist(w.miles * 1609.344)}` : ''}{Number.isFinite(near(w)) ? ` · ${dist(near(w))} away` : ''}
                    </span>
                    <span class="wanted-links">
                      {w.lat != null && <button type="button" class="link" onClick={() => show(w)}>Show on map</button>}
                      {w.source && <a href={w.source} target="_blank" rel="noopener">Park's page <Icon name="external" size={12} /></a>}
                      {w.map && <a href={w.map} target="_blank" rel="noopener">Park's map <Icon name="external" size={12} /></a>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            {sorted.length > shown && <button type="button" class="btn btn-secondary btn-wide" onClick={() => setShown(shown + PAGE)}>Show more</button>}
          </>
        )}
      </div>
    </div>
  );
}
