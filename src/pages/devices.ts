import { devices, type BrowserContextOptions } from '@playwright/test';

/**
 * Devices the cashier can be opened on. The cashier's own JavaScript reads
 * screen size, pixel ratio, user agent, touch, timezone … from the browser and
 * PGS forwards them to the PSP (3DS browser data) – so emulating the device
 * here tests what a customer on that device would send.
 *
 * Emulation runs in Chromium: screen, viewport, pixel ratio, user agent and
 * touch match the device; the engine stays Chrome (Safari-only quirks need a
 * real device).
 */
export const DEVICE_IDS = [
  'desktop',
  'tablet-ipad',
  'tablet-android',
  'phone-iphone',
  'phone-android',
] as const;
export type DeviceId = (typeof DEVICE_IDS)[number];

interface DeviceProfile {
  readonly label: string;
  readonly source: string;
  /** Screen for descriptors that have none (Playwright then reports the viewport). */
  readonly screen?: { readonly width: number; readonly height: number };
}

const PROFILES: Readonly<Record<DeviceId, DeviceProfile>> = {
  desktop: { label: 'Desktop – Chrome, 1280×900', source: 'Desktop Chrome' },
  'tablet-ipad': {
    label: 'Tablet – iPad',
    source: 'iPad (gen 7)',
    screen: { width: 810, height: 1080 },
  },
  'tablet-android': {
    label: 'Tablet – Galaxy Tab S4',
    source: 'Galaxy Tab S4',
    screen: { width: 712, height: 1138 },
  },
  'phone-iphone': { label: 'Phone – iPhone 14', source: 'iPhone 14' },
  'phone-android': { label: 'Phone – Pixel 7', source: 'Pixel 7' },
};

export function isDeviceId(value: string | undefined): value is DeviceId {
  return value !== undefined && (DEVICE_IDS as readonly string[]).includes(value);
}

export function deviceLabel(id: DeviceId): string {
  return PROFILES[id].label;
}

/** Browser-context options for the device (without `defaultBrowserType` – we always launch Chromium). */
export function deviceContextOptions(id: DeviceId): BrowserContextOptions {
  const profile = PROFILES[id];
  const descriptor = devices[profile.source];
  if (descriptor === undefined) throw new Error(`Unknown Playwright device "${profile.source}"`);
  const options: BrowserContextOptions = { ...descriptor };
  Reflect.deleteProperty(options, 'defaultBrowserType');
  return {
    ...options,
    ...(id === 'desktop' ? { viewport: { width: 1280, height: 900 } } : {}),
    ...(profile.screen && options.screen === undefined ? { screen: profile.screen } : {}),
  };
}

/** Device of this run (RUN_DEVICE, set by the launcher); default desktop. */
export function currentDevice(): DeviceId {
  const value = process.env.RUN_DEVICE?.trim();
  return isDeviceId(value) ? value : 'desktop';
}
