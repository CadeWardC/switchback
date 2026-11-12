// Settings, and about: units, theme, the trail files on this device, the open data, credits and the apps.
import { useEffect, useState } from 'preact/hooks';
import { regions, themePref, units, type ThemePref } from '../state';
import { regionName, resetTrailFiles, trailFilesOnDevice, type TrailFilesInfo } from '../data';
import { APP_VERSION } from '../lib/submit';
import type { Units } from '../lib/format';
import { Button, Note, Segmented } from './common';
import { Icon } from './Icon';

const REPO = 'https://github.com/CadeWardC/switchback';
const OPEN = `${REPO}/releases/download/trails-open/`;

function Ext({ href, children }: { href: string; children: any }) {
  return <a href={href} target="_blank" rel="noopener">{children} <Icon name="external" size={13} /></a>;
}

export function Settings() {
  const [files, setFiles] = useState<TrailFilesInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const refresh = () => void trailFilesOnDevice().then(setFiles, () => setFiles({ regions: [], bytes: 0 }));
  useEffect(refresh, []);

  const reset = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await resetTrailFiles());
    } catch {
      setResult("Something went wrong and the trail files couldn't be reset. Try again.");
    }
    setBusy(false);
    refresh();
  };
  const us = regions.value.filter((r) => (r.country ?? 'US') === 'US').sort((a, b) => regionName(a).localeCompare(regionName(b)));
  const other = regions.value.filter((r) => (r.country ?? 'US') !== 'US').sort((a, b) => regionName(a).localeCompare(regionName(b)));

  return (
    <div class="page">
      <div class="page-top">
        <h1 class="page-title">Settings</h1>
      </div>
      <div class="page-scroll settings">
        <section class="card pad">
          <div class="setting">
            <span id="units-label">Units</span>
            <Segmented<Units> label="Units" value={units.value} onChange={(v) => (units.value = v)}
              options={[{ value: 'imperial', label: 'Miles, feet' }, { value: 'metric', label: 'Km, metres' }]} />
          </div>
          <div class="setting">
            <span>Appearance</span>
            <Segmented<ThemePref> label="Appearance" value={themePref.value} onChange={(v) => (themePref.value = v)}
              options={[{ value: 'auto', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </div>
        </section>

        <h2 class="section-title">Trail files on this device</h2>
        <section class="card pad">
          <p>
            {files == null ? 'Checking…'
              : files.regions.length === 0 ? 'None yet. A region\'s trails download the first time the map shows it, then work without a connection.'
              : `${files.regions.length} ${files.regions.length === 1 ? 'region' : 'regions'}${files.bytes ? ` (${(files.bytes / 1e6).toFixed(1)} MB)` : ''}: ${files.regions.join(', ')}.`}
          </p>
          <p class="fine">Trail files are rebuilt regularly. New versions are picked up by themselves; use this if trails look wrong or out of date.</p>
          <Button icon="download" disabled={busy} onClick={() => void reset()}>{busy ? 'Working…' : 'Reset and download again'}</Button>
          {result && <p class="result" role="status">{result}</p>}
        </section>

        <h2 class="section-title">Get the app</h2>
        <section class="card pad">
          <p>Switchback for iPhone and Android records in your pocket and works offline. No account, no subscription.</p>
          <div class="actions">
            <Button icon="download" href={`${REPO}/releases`}>iPhone (IPA)</Button>
            <Button icon="download" href={`${REPO}/releases`}>Android (APK)</Button>
          </div>
          <p class="fine">Both are on the project's Releases page. The iPhone file is unsigned: install it with AltStore, SideStore or Sideloadly.</p>
        </section>

        <h2 class="section-title">Download the trails</h2>
        <section class="card pad">
          <p>
            Every trail here is free to download as open data: one GeoJSON file per US state and Canadian province,
            with each trail's line, length, climb, area and official record.
          </p>
          <div class="link-row">
            <Ext href={`${REPO}/blob/HEAD/docs/DOWNLOADS.md`}>What's in the files</Ext>
            <Ext href={`${REPO}/releases/tag/trails-open`}>All files</Ext>
          </div>
          <details class="downloads">
            <summary>Pick a state or province</summary>
            {[['United States', us], ['Canada and elsewhere', other]].map(([title, list]) => (list as typeof us).length > 0 && (
              <>
                <h3>{title as string}</h3>
                <ul class="download-list">
                  {(list as typeof us).map((r) => <li><a href={`${OPEN}${r.region}.geojson.gz`}>{regionName(r)}</a></li>)}
                </ul>
              </>
            ))}
            {!regions.value.length && <p class="fine">The list of regions isn't loaded. Use "All files" above.</p>}
          </details>
        </section>

        <h2 class="section-title">Credits and licence</h2>
        <section class="card pad credits">
          <p>
            <strong>Trails:</strong> © <Ext href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</Ext>, made
            available under the <Ext href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License (ODbL)</Ext>.
            If you publish something made from them, credit OpenStreetMap and keep the data open under the same licence.
          </p>
          <p>
            <strong>Official records and some trail lines:</strong> USDA Forest Service (National Forest System Trails),
            National Park Service, USGS National Digital Trails, Bureau of Land Management, U.S. Fish and Wildlife Service,
            and state, provincial and city trail lists.
          </p>
          <p><strong>Elevation:</strong> Terrain Tiles (Mapzen, AWS Open Data), built from USGS 3DEP, SRTM, CDEM and others.</p>
          <p>
            <strong>Map:</strong> © OpenStreetMap contributors, tiles by <Ext href="https://openfreemap.org">OpenFreeMap</Ext>,
            map data schema © <Ext href="https://openmaptiles.org">OpenMapTiles</Ext>, drawn with <Ext href="https://maplibre.org">MapLibre</Ext>.
          </p>
          <div class="link-row">
            <Ext href={`${REPO}/blob/HEAD/DATA_LICENSE.md`}>Full data licence</Ext>
            <Ext href={REPO}>Source code</Ext>
          </div>
        </section>

        <Note>Difficulty and times are estimates from length and climb. Trails close and conditions change: check before you go.</Note>
        <p class="fine version">Switchback for the web, version {APP_VERSION}</p>
      </div>
    </div>
  );
}
