// Writing GPX 1.1 files, and handing a file to the browser to save.

export interface GpxPoint { lat: number; lon: number; ele?: number | null; time?: number | null }

export interface GpxTrack { name: string; segments: GpxPoint[][] }

export interface GpxDoc {
  creator: string;
  name: string;
  desc?: string;
  time?: number;
  /** Extra attributes on <gpx> (namespaces) and raw XML for <metadata><extensions>. */
  namespaces?: Record<string, string>;
  metadataExtensions?: string;
  tracks: GpxTrack[];
}

export const xml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
    // characters XML 1.0 does not allow
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function buildGpx(doc: GpxDoc): string {
  const ns = Object.entries(doc.namespaces ?? {}).map(([k, v]) => `\n     xmlns:${k}="${xml(v)}"`).join('');
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${xml(doc.creator)}" xmlns="http://www.topografix.com/GPX/1/1"${ns}>`,
    '  <metadata>',
    `    <name>${xml(doc.name)}</name>`,
  ];
  if (doc.desc) out.push(`    <desc>${xml(doc.desc)}</desc>`);
  out.push(`    <time>${iso(doc.time ?? Date.now())}</time>`);
  if (doc.metadataExtensions) out.push('    <extensions>', doc.metadataExtensions, '    </extensions>');
  out.push('  </metadata>');
  for (const track of doc.tracks) {
    out.push('  <trk>', `    <name>${xml(track.name)}</name>`);
    for (const seg of track.segments) {
      if (!seg.length) continue;
      out.push('    <trkseg>');
      for (const p of seg) {
        let inner = '';
        if (p.ele != null && Number.isFinite(p.ele)) inner += `<ele>${p.ele.toFixed(1)}</ele>`;
        if (p.time != null) inner += `<time>${iso(p.time)}</time>`;
        const at = `lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"`;
        out.push(inner ? `      <trkpt ${at}>${inner}</trkpt>` : `      <trkpt ${at}/>`);
      }
      out.push('    </trkseg>');
    }
    out.push('  </trk>');
  }
  out.push('</gpx>', '');
  return out.join('\n');
}

export function fileName(name: string, ext = 'gpx'): string {
  const base = name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'trail';
  return `${base}.${ext}`;
}

export function downloadText(name: string, text: string, type = 'application/gpx+xml'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
