// "Submit this trail": explains what happens, makes the submission file, then points to the GitHub form.
// How a submission travels is in lib/submit.ts; this is only the conversation with the person.
import { useEffect, useRef, useState } from 'preact/hooks';
import { submitTrail, type Submission, type SubmissionResult } from '../lib/submit';
import type { GpxPoint } from '../lib/gpx';
import { platform } from '../platform';
import { Button, Note, dist } from './common';

const PLACEHOLDERS = /^(trail|my hike|my walk|untitled|walk|hike|route|morning walk|afternoon walk|evening walk|my route)$/i;

export interface SubmitWhat { name: string; kind: 'walked' | 'placed'; points: GpxPoint[]; length: number }

export function SubmitDialog({ what, onClose }: { what: SubmitWhat; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(PLACEHOLDERS.test(what.name.trim()) ? '' : what.name);
  const [notes, setNotes] = useState('');
  const [agree, setAgree] = useState(false);
  const [done, setDone] = useState<SubmissionResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const walked = what.kind === 'walked';
  const short = what.length < 400 || what.points.length < 30;
  const nameOk = name.trim().length > 1 && !PLACEHOLDERS.test(name.trim());

  const send = async (e: Event) => {
    e.preventDefault();
    if (!nameOk || !agree || busy) return;
    setBusy(true);
    const s: Submission = { name: name.trim(), notes, kind: what.kind, publicAccess: true, points: what.points, lengthMetres: what.length };
    try {
      setDone(await submitTrail(s));
      platform.haptics.success();
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} class="dialog" aria-labelledby="submit-title" onClose={onClose} onCancel={onClose}>
      {!done ? (
        <form onSubmit={send}>
          <h2 id="submit-title">Submit this trail</h2>
          <p>
            Send this trail in to be added to Switchback's open trail files. <strong>Every trail is checked before it
            is added</strong>: first automatically, then by a person who compares it with aerial photos and the park's own map.
          </p>
          {!walked && (
            <Note kind="warn">
              This route was placed on the map, not walked. A placed trail is only added when the park's own list
              names it and the ground (lidar) shows it. Otherwise it goes on the "needs verification" list until
              someone walks it or the maintainer accepts it.
            </Note>
          )}
          {walked && short && (
            <Note kind="warn">
              This hike is short ({dist(what.length)}, {what.points.length} points). The checks need at least 400 m and 30 points, so it will probably not pass.
            </Note>
          )}
          <label class="field">
            <span>Trail name, as on the sign</span>
            <input type="text" value={name} maxLength={80} required placeholder="Bluff Loop"
              onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>Notes for the checker (optional)</span>
            <textarea rows={3} value={notes} maxLength={1000} placeholder="Where it starts, signs, anything worth knowing"
              onInput={(e) => setNotes((e.currentTarget as HTMLTextAreaElement).value)} />
          </label>
          <label class="check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree((e.currentTarget as HTMLInputElement).checked)} />
            <span>
              {walked ? 'I walked this myself, on land open to the public on foot. ' : 'As far as I know this is on land open to the public on foot. '}
              I agree it may be published in Switchback's open trail files under the{' '}
              <a href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noopener">Open Database License</a>.
            </span>
          </label>
          <p class="fine">
            There are two steps: a file with your trail is {platform.name === 'web' ? 'saved to your downloads' : 'made'}, then you
            attach it to a short form on GitHub (a free GitHub account is needed). {walked ? 'The file holds the time of each point of your walk; only the date is kept once it is checked.' : ''}
          </p>
          <div class="dialog-actions">
            <Button kind="quiet" onClick={() => ref.current?.close()}>Cancel</Button>
            <Button kind="primary" icon="download" type="submit" disabled={!nameOk || !agree || busy}>Save the file</Button>
          </div>
        </form>
      ) : (
        <div>
          <h2 id="submit-title">One more step</h2>
          <ol class="steps">
            <li><strong>{done.fileName}</strong> was {platform.files.exportVerb}.</li>
            <li>Open the form below. The details are filled in already.</li>
            <li>
              Attach the file to the form. GitHub doesn't take .gpx files as they are: zip it first, or rename it
              so it ends in <code>.gpx.txt</code>. Then press "Create".
            </li>
          </ol>
          <p class="fine">Your trail is checked before it is added{walked ? '' : '. A placed trail that can\'t be proved from the park\'s list and the lidar waits on the "needs verification" list'}. You'll get replies on the GitHub page.</p>
          <div class="dialog-actions">
            <Button kind="quiet" onClick={() => ref.current?.close()}>Done</Button>
            <Button kind="primary" icon="external" href={done.issueUrl}>Open the GitHub form</Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
