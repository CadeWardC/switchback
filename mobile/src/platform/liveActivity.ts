// The hike on the lock screen and in the Dynamic Island (an iPhone Live Activity). The native half is the
// local module in modules/hike-activity (it starts, updates and ends the activity) and the widget in
// targets/hike (it draws it). Where that module is not built in (Android, where the recording notice does
// this job, and tests), every call here does nothing.
import { requireOptionalNativeModule } from 'expo';

export interface LiveHikeState {
  /** "1.4 mi" */
  walked: string;
  /** When the hike began (ms since 1970): the lock screen counts up from it by itself. */
  started: number;
  paused: boolean;
  /** While a trail is followed: "0.8 mi", what that is ("Left", "Left, out and back", "Back to your start")
   *  and the time you would be done ("2:48"). */
  left: string | null;
  leftLabel: string | null;
  backBy: string | null;
  /** While off the trail: "200 ft to your right". */
  offTrail: string | null;
}

interface Native {
  update(name: string, state: LiveHikeState): Promise<boolean>;
  end(): Promise<void>;
}

const native = requireOptionalNativeModule<Native>('HikeActivity');

export const liveHike = {
  available: !!native,
  /** Shows the hike, or changes what is shown. The first call must be made with the app on screen. */
  update(name: string, state: LiveHikeState): void {
    native?.update(name, state).catch(() => {});
  },
  end(): void {
    native?.end().catch(() => {});
  },
};
