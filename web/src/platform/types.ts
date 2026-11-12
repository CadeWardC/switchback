// Everything the site asks of the device goes through this one interface. The browser version is in
// ./browser.ts; a Capacitor version (native location service, share sheet, app files, release downloads)
// can be added beside it and chosen in ./index.ts without touching any screen.

export interface Fix {
  lat: number;
  lon: number;
  /** Metres above sea level, when the device knows. */
  ele: number | null;
  /** How far off the fix may be, in metres. */
  accuracy: number;
  /** Milliseconds since 1970. */
  time: number;
}

export type LocationProblem = 'denied' | 'unavailable' | 'unsupported';
export type FixHandler = (fix: Fix) => void;
export type ProblemHandler = (problem: LocationProblem) => void;

export interface PlatformLocation {
  /** Whether a recording carries on with the screen off or the app in the background. */
  readonly recordsInBackground: boolean;
  current(): Promise<Fix>;
  /** Follows the device while the app is open (the dot on the map). Returns a function that stops it. */
  watch(onFix: FixHandler, onProblem: ProblemHandler): () => void;
  /** Starts a recording: fixes arrive until stopRecording. Native: a background location service, with
   *  `notice` as the text of the notification Android shows while it runs. Fixes carry their own time and
   *  may arrive late and several at once (after the page was asleep). */
  startRecording(onFix: FixHandler, onProblem: ProblemHandler, notice: { title: string; text: string }): Promise<void>;
  stopRecording(): Promise<void>;
}

export interface PlatformKeepAwake {
  /** Keeps the screen on. Resolves to whether it worked. */
  on(): Promise<boolean>;
  off(): Promise<void>;
}

export interface PlatformFiles {
  /** Hands a file to the person. Browser: a download. Native: the share sheet. */
  exportText(name: string, text: string, type: string): Promise<void>;
  /** "saved to your downloads" or "handed to the share sheet": for messages. */
  readonly exportVerb: string;
  /** Shares a link. Browser: copies it. Native: the share sheet. Resolves to what happened, for a message. */
  shareLink(title: string, url: string): Promise<'copied' | 'shared' | 'failed'>;
}

/** Small values: settings, saved trails, planned routes, recorded hikes. */
export interface PlatformKeyValue {
  get(key: string): string | null;
  /** False when it could not be kept (storage full or blocked). */
  set(key: string, value: string): boolean;
  remove(key: string): void;
}

/** Large files kept on the device: the trail files. Browser: Cache Storage. Native: the app's files. */
export interface PlatformFileStore {
  read(name: string): Promise<ArrayBuffer | null>;
  write(name: string, data: ArrayBuffer): Promise<boolean>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
  /** Native only: downloads an address straight into the store (no CORS limit, nothing passes through
   *  the page). When absent, the caller fetches and then writes. Throws when the download fails. */
  download?(url: string, name: string): Promise<void>;
}

/** The person's own things: recorded hikes, planned routes, saved trails. Browser: IndexedDB. Native: the
 *  app's files. Each document is text (JSON); a log is a document that only grows, a line at a time (a
 *  recording in progress), so a long hike is never rewritten whole. */
export interface PlatformDocuments {
  read(name: string): Promise<string | null>;
  /** False when it could not be kept. */
  write(name: string, text: string): Promise<boolean>;
  remove(name: string): Promise<void>;
  append(log: string, line: string): Promise<boolean>;
  readLog(log: string): Promise<string[]>;
  removeLog(log: string): Promise<void>;
}

export interface PlatformNotifications {
  /** Asks to show notifications (needed on Android 13+ for the recording notice too). */
  request(): Promise<boolean>;
  /** Shows a notification now. Browser: nothing (the page is open, or it is not running). */
  show(title: string, body: string): Promise<void>;
}

export interface PlatformApp {
  /** The hardware or gesture "back" on Android. The handler returns true when it dealt with it; otherwise
   *  the app is put away. Browser: never called (the browser's own back button works on the address). */
  onBack(handler: () => boolean): void;
  /** Light or dark system bars to suit the theme. */
  setTheme(dark: boolean): void;
  /** Called when the app comes back to the front. */
  onResume(handler: () => void): void;
}

export interface PlatformLinks {
  /** Opens a web page outside the app. */
  open(url: string): void;
  /** Opens driving directions to a place in the device's maps app. */
  directions(lat: number, lon: number): void;
  /** The address of those directions, for a plain link. */
  directionsUrl(lat: number, lon: number): string;
  /** Opens the device's settings page for this app (to allow location). Browser: nothing. */
  openSettings(): void;
}

export interface PlatformHaptics {
  tap(): void;
  success(): void;
}

export interface PlatformTrailFiles {
  /** Where "regions.json" and "<region>.trails" are fetched from. Browser: beside the site (release
   *  downloads send no CORS headers). Native: the GitHub release itself. */
  url(file: string): string;
  /** A small JSON file from there, fresh. Resolves to null when there is no such file (404). */
  getJson(file: string): Promise<unknown | null>;
}

export interface Platform {
  readonly name: 'web' | 'ios' | 'android';
  /** Anything that must be ready before the first screen (native: settings are read into memory). */
  init(): Promise<void>;
  documents: PlatformDocuments;
  notifications: PlatformNotifications;
  app: PlatformApp;
  location: PlatformLocation;
  keepAwake: PlatformKeepAwake;
  files: PlatformFiles;
  keyValue: PlatformKeyValue;
  fileStore: PlatformFileStore;
  links: PlatformLinks;
  haptics: PlatformHaptics;
  trailFiles: PlatformTrailFiles;
}
