// Submitting a recorded hike for review. Offered as soon as a hike is finished, and from any kept hike in the
// Log. A submission needs a real trail name; it may carry a 1-5 star review; the spots marked during the hike
// go with it (so every spot comes from someone who walked there). Nothing is added to the trail data until it
// has been checked and approved (the review page, /review on the server). The hiker agrees first that what they submit may be shown
// publicly and that photos they submit are for public use.
//
// It goes to the server as a new trail (PUT /v1/submissions/{id}, from your account), waiting for approval on
// the review page (/review); the hike's page in the Log shows where it stands and any reply.
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, Switch, TextInput, View } from 'react-native';
import { signal } from '@preact/signals-core';
import { fmtDistance, fmtElevation } from '@web/lib/format';
import type { Walk } from '@web/lib/storage';
import { platform } from '../platform';
import { renameWalk, say, shownWalk, units, updateWalk } from '../core/state';
import { account, api, isSignedIn } from '../core/server';
import { trailSubmission, uuid } from '../core/syncFormat';
import { difficultyOf } from '@web/lib/trail';
import type { Coord } from '@web/lib/polyline';
import { useValue } from '../ui/hooks';
import { Button, Icon, Note, T, Tap } from '../ui/kit';
import { fonts, radius, useTheme } from '../ui/theme';

/** What everyone is told before they send anything in. */
export const PUBLIC_USE = 'By submitting, you agree that your hike, the spots you marked and your review may be shown publicly in Switchback, and that any photos you submit are for public use: anyone may see, share and reuse them. Every submission is checked before it is added to the trail data.';

const PLACEHOLDERS = /^(trail|my hike|my walk|untitled|walk|hike|route|morning walk|afternoon walk|evening walk|morning hike|afternoon hike|evening hike|night hike|my route)$/i;
export const isRealName = (n: string) => n.trim().length >= 3 && !PLACEHOLDERS.test(n.trim());

/** The hike being offered for submission (null: the dialog is closed). */
export const submitting = signal<Walk | null>(null);

/** Sends a hike in as a new trail; returns the submission's id. Needs an account. */
export async function submitHike(w: Walk, name: string, review: { rating: number | null; text: string } | null): Promise<string> {
  const id = uuid();
  const path = w.segments.flat().map((p) => [p.lat, p.lon] as Coord);
  const difficulty = difficultyOf(w.length, w.gain ?? 0, {});
  await api.call('PUT', `/v1/submissions/${id}`, trailSubmission(w, name, review, path.length > 1 ? difficulty : undefined));
  return id;
}

export function SubmitModal() {
  const t = useTheme();
  const w = useValue(submitting);
  const u = useValue(units);
  const signedIn = !!useValue(account) && isSignedIn();
  const [name, setName] = useState('');
  const [rating, setRating] = useState(0);
  const [review, setReview] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!w) return;
    setName(isRealName(w.name) ? w.name : '');
    setRating(0); setReview(''); setAgree(false); setError(null); setBusy(false);
  }, [w?.id]);

  if (!w) return null;
  const close = () => { submitting.value = null; };
  const nameOk = isRealName(name);
  const markers = w.markers ?? [];
  const input = { borderRadius: radius.control, backgroundColor: t.c.card, paddingHorizontal: 12, color: t.c.ink, fontFamily: fonts.regular, fontSize: 16 } as const;

  const send = async () => {
    if (!nameOk || !agree || busy) return;
    setBusy(true);
    setError(null);
    const text = review.trim();
    try {
      const n = name.trim();
      if (n !== w.name) await renameWalk(w.id, n);
      const id = await submitHike({ ...w, name: n }, n, rating || text ? { rating: rating || null, text } : null);
      await updateWalk(w.id, { submission: id });
      // the hike open in the Log shows it at once
      const open = shownWalk.peek();
      if (open && open.id === w.id) shownWalk.value = { ...open, name: n, submission: id };
      platform.haptics.success();
      say('Submitted. It will be checked before it is added.');
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.c.bg }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <T v="name">Submit this hike?</T>
            <Tap onPress={close} accessibilityLabel="Not now" style={{ padding: 6 }}><Icon name="close" size={22} color={t.c.muted} /></Tap>
          </View>
          <T v="body" muted>
            It's kept on this phone and in Saved as your own trail either way. Submit it to have it checked and, if it's
            right, added to Switchback's trails for everyone.
          </T>

          <View style={{ gap: 6 }}>
            <T v="label" muted>Trail name</T>
            <TextInput value={name} onChangeText={setName} placeholder="The trail's name" placeholderTextColor={t.c.muted} maxLength={80}
              style={[input, { height: 48 }]} accessibilityLabel="Trail name" />
            <T v="tiny" muted>{nameOk ? `Hiked ${fmtDistance(w.length, u)}${w.gain != null ? `, ↑ ${fmtElevation(w.gain, u)}` : ''}.` : 'A submitted hike needs the trail\'s name.'}</T>
          </View>

          <View style={{ gap: 6 }}>
            <T v="label" muted>Spots you marked</T>
            <T v="small">{markers.length ? markers.map((m) => m.name || 'Spot').join(', ') : 'None. While recording, use Mark a spot for water, views, junctions or hazards.'}</T>
          </View>

          <View style={{ gap: 8 }}>
            <T v="label" muted>Review (optional)</T>
            <View style={{ flexDirection: 'row', gap: 6 }} accessibilityRole="adjustable" accessibilityLabel={`Rating: ${rating || 'none'} of 5`}>
              {[1, 2, 3, 4, 5].map((i) => (
                <Tap key={i} onPress={() => setRating(rating === i ? 0 : i)} accessibilityLabel={`${i} star${i === 1 ? '' : 's'}`} style={{ padding: 4 }}>
                  <T v="title" color={i <= rating ? '#e0a400' : t.c.line2}>{i <= rating ? '★' : '☆'}</T>
                </Tap>
              ))}
            </View>
            <TextInput value={review} onChangeText={setReview} placeholder="How was it?" placeholderTextColor={t.c.muted} multiline maxLength={2000}
              style={[input, { minHeight: 90, paddingTop: 10, textAlignVertical: 'top' }]} accessibilityLabel="Review" />
          </View>

          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <T v="strong" style={{ flex: 1 }}>I agree</T>
              <Switch value={agree} onValueChange={setAgree} trackColor={{ true: t.c.primary, false: t.c.line2 }} accessibilityLabel="I agree to public use" />
            </View>
            <T v="small" muted>{PUBLIC_USE}</T>
          </View>

          {!signedIn && <Note>Log in or create an account (Settings › Account) to submit hikes. Your hike is already saved on this phone.</Note>}
          {error && <Note warn>{error}</Note>}

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button big title="Not now" onPress={close} style={{ flex: 1 }} />
            <Button big kind="primary" title={busy ? 'Sending…' : 'Submit'} onPress={() => void send()} disabled={!nameOk || !agree || !signedIn || busy} style={{ flex: 1 }} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** On a kept hike: where its submission stands, or a button to submit it. */
export function SubmissionRow({ walk }: { walk: Walk }) {
  const t = useTheme();
  const [status, setStatus] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (walk.submission && isSignedIn()) {
      void (api.call('GET', '/v1/me/submissions') as Promise<{ submissions: { id: string; status: string; reply: string }[] }>)
        .then((d) => {
          const mine = d.submissions.find((x) => x.id === walk.submission);
          if (live && mine) { setStatus(mine.status); setReply(mine.reply || null); }
        }, () => {});
    }
    return () => { live = false; };
  }, [walk.submission]);
  if (!walk.submission) {
    return <Button icon="flag" title="Submit for review" onPress={() => { submitting.value = walk; }} />;
  }
  const label = status === 'approved' ? 'Submitted: approved and added to the trail data'
    : status === 'rejected' ? 'Submitted: not added after review'
      : status ? 'Submitted: waiting for review' : 'Submitted for review';
  return (
    <View style={{ gap: 2 }}>
      <T v="small" color={status === 'approved' ? t.c.green : t.c.muted}>{label}</T>
      {reply ? <T v="small" muted>“{reply}”</T> : null}
    </View>
  );
}
