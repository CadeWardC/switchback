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
  /** Starts a recording: fixes arrive until stopRecording. Native: a background location service. */
  startRecording(onFix: FixHandler, onProblem: ProblemHandler): Promise<void>;
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
  /** "saved to your downloads" or "shared": for messages. */
  readonly exportVerb: string;
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
}

export interface PlatformLinks {
  /** Opens a web page outside the app. */
  open(url: string): void;
  /** Opens driving directions to a place in the device's maps app. */
  directions(lat: number, lon: number): void;
  /** The address of those directions, for a plain link. */
  directionsUrl(lat: number, lon: number): string;
}

export interface PlatformHaptics {
  tap(): void;
  success(): void;
}

export interface PlatformTrailFiles {
  /** Where "regions.json" and "<region>.trails" are fetched from. Browser: beside the site (release
   *  downloads send no CORS headers). Native: the GitHub release itself. */
  url(file: string): string;
}

export interface Platform {
  readonly name: 'web' | 'ios' | 'android';
  location: PlatformLocation;
  keepAwake: PlatformKeepAwake;
  files: PlatformFiles;
  keyValue: PlatformKeyValue;
  fileStore: PlatformFileStore;
  links: PlatformLinks;
  haptics: PlatformHaptics;
  trailFiles: PlatformTrailFiles;
}
