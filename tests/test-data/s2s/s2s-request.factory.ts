import type { CashierCard } from '@app-types/cashier.types';
import type { S2sTemplate } from '@config/settings';
import { currentDevice, deviceContextOptions, type DeviceId } from '@pages/devices';

/**
 * S2S card payment body (POST /api/v1/p/{purchaseId}/?s2s=true): card details plus the
 * customer's browser data, as a merchant's own checkout would collect them. Browser data
 * comes from the device chosen on the Run tab (same profiles as the cashier tests), so the
 * 3DS data PGS forwards to the PSP matches that device.
 *
 * remote_ip: the CUSTOMER's IP – PGS rejects it when it equals the IP calling the API
 * ("Client Ip could not be match with Merchant Ip"). Default is a public test IP; override
 * with S2S_REMOTE_IP.
 */
export type S2sBody = Record<string, unknown>;

export const DEFAULT_REMOTE_IP = '157.38.242.7';

export interface S2sOptions {
  /** Baseline from the launcher's S2S data tab (envData.s2s); built-in defaults when absent. */
  readonly template?: S2sTemplate;
  /** "on" stores the card for the customer (card-on-file), "off" does not. Default off. */
  readonly rememberCard?: 'on' | 'off';
  readonly device?: DeviceId;
  readonly remoteIp?: string;
}

/** Browser data of a device profile (what the customer's browser would report). */
export function browserData(device: DeviceId = currentDevice()): S2sBody {
  const options = deviceContextOptions(device);
  const screen = options.screen ?? options.viewport ?? { width: 1920, height: 1080 };
  return {
    user_agent:
      options.userAgent ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    accept_header: 'text/html',
    language: options.locale ?? 'en-US',
    java_enabled: 'false',
    javascript_enabled: true,
    color_depth: 24,
    utc_offset: 0,
    screen_width: screen.width,
    screen_height: screen.height,
  };
}

/** S2S_REMOTE_IP (shell / CI) overrides the S2S data tab. */
function remoteIpFromEnv(): string | undefined {
  const value = process.env.S2S_REMOTE_IP?.trim() ?? '';
  return value === '' ? undefined : value;
}

export function buildS2sRequest(card: CashierCard, options: S2sOptions = {}): S2sBody {
  const t = options.template;
  const device = browserData(options.device);
  const browser =
    t === undefined
      ? device
      : {
          user_agent: t.browserData === 'device' ? device.user_agent : t.user_agent,
          accept_header: t.accept_header,
          language: t.language,
          java_enabled: t.java_enabled,
          javascript_enabled: t.javascript_enabled,
          color_depth: t.color_depth,
          utc_offset: t.utc_offset,
          screen_width: t.browserData === 'device' ? device.screen_width : t.screen_width,
          screen_height: t.browserData === 'device' ? device.screen_height : t.screen_height,
        };
  return {
    cardholder_name: card.holderName,
    card_number: card.number,
    expires: card.expiry,
    cvc: card.cvv,
    remember_card: options.rememberCard ?? t?.remember_card ?? 'off',
    remote_ip: options.remoteIp ?? remoteIpFromEnv() ?? t?.remote_ip ?? DEFAULT_REMOTE_IP,
    ...browser,
    ...(t?.extraFields ?? {}),
  };
}

/** Body with fields changed (`undefined` removes a field) – for validation cases. */
export function changedS2sBody(base: S2sBody, changes: Readonly<Record<string, unknown>>): S2sBody {
  const body: S2sBody = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) Reflect.deleteProperty(body, key);
    else body[key] = value;
  }
  return body;
}
