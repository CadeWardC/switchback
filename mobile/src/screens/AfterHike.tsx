// After a hike: review the trail and add photos. That is all most hikes need, and none of it sends the recorded
// track anywhere: a review is stars and words about a trail, and photos go up on their own.
//
// The track (the GPS points you walked) is only sent in when you say so, by choosing one of two things:
//   • there is a problem with this trail (its line is wrong, it is closed, it is not there): a correction, with
//     the walked line so whoever checks it can see what is really on the ground;
//   • this is a new trail, missing from the map: the walked line, a real name and the spots marked on the way.
// Either goes to the server's review queue (PUT /v1/submissions/{id}) and changes nothing until it has been checked
// (the review page, /review on the server). The hike's page in the Log shows where it stands and any reply.
//
// The sheet opens by itself when a hike is finished, and from a kept hike in the Log or a trail's page (Write a
// review) for a hike already kept.
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, ScrollView, Switch, TextInput, View } from 'react-native';
import { signal } from '@preact/signals-core';
import { fmtDistance, fmtDuration, fmtElevation } from '@web/lib/format';
import type { Walk } from '@web/lib/storage';
import { difficultyOf } from '@web/lib/trail';
import { platform } from '../platform';
import { renameWalk, say, shownWalk, units, updateWalk } from '../core/state';
import { account, api, isSignedIn } from '../core/server';
import { PROBLEMS, trailProblem, trailSubmission, uuid, type ProblemKey } from '../core/syncFormat';
import { communityChanged, deleteReview, PUBLIC_POSTS, saveReview, trailRefOfWalk, trailReviews, type Review } from '../core/community';
import { useValue } from '../ui/hooks';
import { Button, Card, Chip, Icon, Note, RadioRow, T, Tap } from '../ui/kit';
import { HikePhotos } from '../ui/MyPhotos';
import { fonts, radius, useTheme } from '../ui/theme';

/** What everyone is told before they send their track in. */
export const PUBLIC_USE = 'By sending this, you agree that your hike\'s track, the spots you marked and what you wrote may be shown publicly in Switchback, and that any photos you add are for public use: anyone may see, share and reuse them. Everything sent in is checked before the map is changed.';

const PLACEHOLDERS = /^(trail|my hike|my walk|untitled|walk|hike|route|morning walk|afternoon walk|evening walk|morning hike|afternoon hike|evening hike|night hike|my route)$/i;
export const isRealName = (n: string) => n.trim().length >= 3 && !PLACEHOLDERS.test(n.trim());

/** What, if anything, is being sent in about the map: nothing (the track stays put), a problem, or a new trail. */
type Report = 'none' | 'problem' | 'new';

/** The hike the sheet is open for (null: closed). `fresh`: just finished. `report`: opened to send something in. */
export const followUp = signal<{ walk: Walk; fresh?: boolean; report?: Exclude<Report, 'none'> } | null>(null);

function Stars({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 6 }} accessibilityRole="adjustable" accessibilityLabel={`Rating: ${value || 'none'} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Tap key={i} onPress={() => onChange(value === i ? 0 : i)} accessibilityLabel={`${i} star${i === 1 ? '' : 's'}`} style={{ padding: 4 }}>
          <T v="title" color={i <= value ? '#e0a400' : t.c.line2}>{i <= value ? '★' : '☆'}</T>
        </Tap>
      ))}
    </View>
  );
}

export function AfterHikeModal() {
  const t = useTheme();
  const open = useValue(followUp);
  const u = useValue(units);
  const signedIn = !!useValue(account) && isSignedIn();
  const me = useValue(account);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [mine, setMine] = useState<Review | null>(null);
  const [report, setReport] = useState<Report>('none');
  const [problem, setProblem] = useState<ProblemKey>('line');
  const [wrong, setWrong] = useState('');
  const [name, setName] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const w = open?.walk ?? null;
  const ref = w ? trailRefOfWalk(w) : null;

  useEffect(() => {
    if (!open || !w) return;
    setRating(0); setBody(''); setMine(null); setWrong(''); setProblem('line'); setAgree(false); setError(null); setBusy(false);
    setSent(w.submission ?? null);
    setReport(w.submission ? 'none' : open.report === 'problem' && !ref ? 'new' : open.report ?? 'none');
    setName(isRealName(w.name) && !w.trail ? w.name : '');
    // your review of this trail, if you have written one: it opens ready to change
    let live = true;
    const id = me?.id;
    if (ref && id && isSignedIn()) {
      void trailReviews(ref.id).then((r) => {
        const found = r.reviews.find((x) => x.user_id === id);
        if (live && found) { setMine(found); setRating(found.rating); setBody(found.body); setAgree(true); }
      }, () => { /* offline: a new one; the server says if there is one already */ });
    }
    return () => { live = false; };
  }, [open]);

  if (!open || !w) return null;
  const close = () => { followUp.value = null; };
  const input = { borderRadius: radius.control, backgroundColor: t.c.card, paddingHorizontal: 12, color: t.c.ink, fontFamily: fonts.regular, fontSize: 16 } as const;

  const text = body.trim();
  // a review belongs to a trail on the map; on a hike of no known trail the stars and words go with the new trail
  const reviewChanged = !!ref && rating > 0 && (!mine || mine.rating !== rating || mine.body !== text);
  const sending = report !== 'none' && !sent;
  const nameOk = isRealName(name);
  const posting = reviewChanged || sending;
  const ready = !posting || (signedIn && agree && (report !== 'new' || !sending || nameOk));

  const done = async () => {
    if (busy) return;
    if (!posting) { close(); return; }
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      if (reviewChanged && ref) {
        const saved = await saveReview(ref, rating, text, w.started, mine?.id);
        setMine(saved);
        communityChanged.value++;
      }
      if (sending) {
        const id = uuid();
        let kept: Partial<Walk> = { submission: id };
        if (report === 'problem' && ref) {
          await api.call('PUT', `/v1/submissions/${id}`, trailProblem(w, ref, problem, wrong));
        } else {
          const n = name.trim();
          if (n !== w.name) { await renameWalk(w.id, n); kept = { ...kept, name: n }; }
          const pts = w.segments.reduce((sum, s) => sum + s.length, 0);
          await api.call('PUT', `/v1/submissions/${id}`, trailSubmission({ ...w, name: n }, n,
            !ref && (rating || text) ? { rating: rating || null, text } : null, pts > 1 ? difficultyOf(w.length, w.gain ?? 0, {}) : undefined));
        }
        await updateWalk(w.id, { submission: id });
        setSent(id);
        // the hike open in the Log shows it at once
        const shown = shownWalk.peek();
        if (shown && shown.id === w.id) shownWalk.value = { ...shown, ...kept };
      }
      platform.haptics.success();
      say(sending ? 'Sent. It will be checked before the map is changed.' : mine ? 'Review updated' : 'Review posted');
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = () => Alert.alert('Delete your review?', 'It is taken off the trail for everyone.', [
    { text: 'Keep', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => {
      try { await deleteReview(mine!.id); communityChanged.value++; setMine(null); setRating(0); setBody(''); say('Review deleted'); } catch (e) { setError((e as Error).message); }
    } },
  ]);

  const title = open.fresh ? 'Hike saved' : w.trail ? `Your hike of ${w.trail.name}` : w.name;
  const action = busy ? 'Sending…' : sending ? (reviewChanged ? 'Post and send' : 'Send') : reviewChanged ? (mine ? 'Save review' : 'Post review') : 'Done';

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.c.bg }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <T v="name" style={{ flex: 1 }} numberOfLines={2}>{title}</T>
            <Tap onPress={close} accessibilityLabel="Close" style={{ padding: 6 }}><Icon name="close" size={22} color={t.c.muted} /></Tap>
          </View>
          {open.fresh && (
            <T v="body" muted>
              {fmtDistance(w.length, u)} in {fmtDuration(w.seconds)}{w.gain != null && w.gain >= 1 ? `, ↑ ${fmtElevation(w.gain, u)}` : ''}. It's in your Log{w.trail ? '' : ', and in Saved as your own trail'}.
            </T>
          )}

          <View style={{ gap: 8 }}>
            <T v="section">Photos</T>
            <HikePhotos walk={w} inset={40} />
          </View>

          {ref && (
            <View style={{ gap: 8 }}>
              <T v="section">{mine ? 'Your review' : `How was ${ref.name}?`}</T>
              <Stars value={rating} onChange={setRating} />
              <TextInput value={body} onChangeText={setBody} placeholder="Conditions, highlights, what to know." placeholderTextColor={t.c.muted}
                multiline maxLength={4000} accessibilityLabel="Review"
                style={[input, { minHeight: 100, paddingTop: 10, textAlignVertical: 'top' }]} />
              {text && !rating ? <T v="tiny" muted>Pick a star rating to post your review.</T> : null}
              {mine && <Tap onPress={remove} accessibilityRole="button" style={{ alignSelf: 'flex-start' }}><T v="small" color={t.c.hard}>Delete your review</T></Tap>}
            </View>
          )}

          <View style={{ gap: 8 }}>
            <T v="section">Is the map right?</T>
            {sent ? (
              <SubmissionStatus id={sent} />
            ) : (
              <>
                <Card style={{ padding: 0, overflow: 'hidden' }}>
                  <RadioRow first on={report === 'none'} onPress={() => setReport('none')} title="Nothing to send in" sub="Your GPS track is not sent" />
                  {ref && <RadioRow on={report === 'problem'} onPress={() => setReport('problem')} title="There's a problem with this trail" sub="Sends your GPS track to be checked" />}
                  <RadioRow on={report === 'new'} onPress={() => setReport('new')} title="This is a new trail" sub="Sends your GPS track so it can be added" />
                </Card>
                {report === 'problem' && (
                  <View style={{ gap: 8 }}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="radiogroup">
                      {PROBLEMS.map((p) => <Chip key={p.key} on={p.key === problem} onPress={() => setProblem(p.key)} label={p.label} />)}
                    </View>
                    <TextInput value={wrong} onChangeText={setWrong} placeholder="What's wrong, and where?" placeholderTextColor={t.c.muted} multiline maxLength={1000}
                      accessibilityLabel="What is wrong with the trail" style={[input, { minHeight: 80, paddingTop: 10, textAlignVertical: 'top' }]} />
                  </View>
                )}
                {report === 'new' && (
                  <View style={{ gap: 8 }}>
                    <TextInput value={name} onChangeText={setName} placeholder="The trail's name" placeholderTextColor={t.c.muted} maxLength={80}
                      style={[input, { height: 48 }]} accessibilityLabel="Trail name" />
                    {!nameOk && <T v="tiny" muted>A new trail needs its name.</T>}
                    {(w.markers?.length ?? 0) > 0 && <T v="tiny" muted>Spots you marked go with it: {w.markers!.map((m) => m.name || 'spot').join(', ')}.</T>}
                    {!ref && (
                      <>
                        <T v="label" muted>Review (optional)</T>
                        <Stars value={rating} onChange={setRating} />
                        <TextInput value={body} onChangeText={setBody} placeholder="How was it?" placeholderTextColor={t.c.muted} multiline maxLength={2000}
                          style={[input, { minHeight: 80, paddingTop: 10, textAlignVertical: 'top' }]} accessibilityLabel="Review" />
                      </>
                    )}
                  </View>
                )}
                {report === 'none'
                  ? <T v="tiny" muted>Only your review and photos are shared. The GPS track of your hike is sent in only if you choose one of the other two.</T>
                  : <Note>The GPS track you recorded on this hike is sent with this, so it can be checked against the map. Nothing on the map changes until it has been.</Note>}
              </>
            )}
          </View>

          {posting && (
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <T v="strong" style={{ flex: 1 }}>I agree</T>
                <Switch value={agree} onValueChange={setAgree} trackColor={{ true: t.c.primary, false: t.c.line2 }} accessibilityLabel="I agree to public use" />
              </View>
              <T v="small" muted>{sending ? PUBLIC_USE : PUBLIC_POSTS}</T>
            </View>
          )}

          {posting && !signedIn && <Note>Log in or create an account (Settings › Account) to post a review or send anything in. Your hike and its photos are already kept on this phone.</Note>}
          {error && <Note warn>{error}</Note>}

          <Button big kind="primary" title={action} onPress={() => void done()} disabled={!ready || busy} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Where something you sent in stands, and any reply. */
function SubmissionStatus({ id }: { id: string }) {
  const t = useTheme();
  const [status, setStatus] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (isSignedIn()) {
      void (api.call('GET', '/v1/me/submissions') as Promise<{ submissions: { id: string; status: string; reply: string }[] }>)
        .then((d) => {
          const mine = d.submissions.find((x) => x.id === id);
          if (live && mine) { setStatus(mine.status); setReply(mine.reply || null); }
        }, () => {});
    }
    return () => { live = false; };
  }, [id]);
  const label = status === 'approved' ? 'Sent in: approved, and the map has been updated'
    : status === 'rejected' ? 'Sent in: the map was left as it is after checking'
      : status ? 'Sent in: waiting to be checked' : 'Sent in to be checked';
  return (
    <View style={{ gap: 2 }}>
      <T v="small" color={status === 'approved' ? t.c.green : t.c.muted}>{label}</T>
      {reply ? <T v="small" muted>“{reply}”</T> : null}
    </View>
  );
}

/** On a kept hike: where what you sent in stands, or a button to report a problem with the trail or a new trail. */
export function SubmissionRow({ walk }: { walk: Walk }) {
  if (walk.submission) return <SubmissionStatus id={walk.submission} />;
  return (
    <Button icon="flag" title={walk.trail ? 'Report a problem or a new trail' : 'Send in as a new trail'}
      onPress={() => { followUp.value = { walk, report: walk.trail ? 'problem' : 'new' }; }} />
  );
}
