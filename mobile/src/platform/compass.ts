// The compass: which way the top of the phone points, for the arrow on the location dot (turn on the spot
// and the arrow turns, so you can tell which path is which before you have taken a step). Only while the
// app is on screen: a recording in your pocket does not keep the compass running.
import { AppState } from 'react-native';
import * as Location from 'expo-location';

/** Turns smaller than this are not passed on (the map source is rewritten for each one). */
const MIN_TURN = 3;

const turn = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Follows the compass. `on` gets degrees clockwise from north (true north when the phone knows it), or
 *  null when the reading is not to be trusted. Returns a function that stops it. */
export function watchCompass(on: (degrees: number | null) => void): () => void {
  let stopped = false;
  let sub: Location.LocationSubscription | null = null;
  let starting = false;
  let last: number | null = null;

  const start = async () => {
    if (sub || starting || stopped) return;
    starting = true;
    try {
      const s = await Location.watchHeadingAsync((h) => {
        const deg = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
        const value = h.accuracy > 0 && Number.isFinite(deg) && deg >= 0 ? deg : null;
        if (value != null && last != null && turn(value, last) < MIN_TURN) return;
        if (value === last) return;
        last = value;
        on(value);
      });
      if (stopped || AppState.currentState !== 'active') s.remove();
      else sub = s;
    } catch { /* no compass on this device: the dot stays a dot */ }
    starting = false;
  };
  const pause = () => {
    sub?.remove();
    sub = null;
  };

  const appState = AppState.addEventListener('change', (s) => { if (s === 'active') void start(); else pause(); });
  if (AppState.currentState === 'active') void start();
  return () => {
    stopped = true;
    appState.remove();
    pause();
  };
}
