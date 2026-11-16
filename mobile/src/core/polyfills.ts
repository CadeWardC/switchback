// What the website's logic expects of a browser and Hermes may lack. Imported first, by index.ts.
import { strFromU8 } from 'fflate';

const g = globalThis as Record<string, unknown>;
if (typeof g.TextDecoder === 'undefined') {
  // UTF-8 only, which is all the trail files use
  g.TextDecoder = class {
    decode(input?: ArrayBufferView | ArrayBuffer): string {
      if (!input) return '';
      const u8 = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      return strFromU8(u8);
    }
  };
}
