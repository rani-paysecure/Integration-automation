import { expect, test } from '@playwright/test';
import { DEVICE_IDS, currentDevice, deviceContextOptions, isDeviceId } from '@pages/devices';

test.describe('Cashier devices', () => {
  test('every device has a screen, viewport and user agent – and no browser override', () => {
    for (const id of DEVICE_IDS) {
      const options = deviceContextOptions(id);
      expect(options.viewport, id).toBeTruthy();
      expect(options.userAgent, id).toBeTruthy();
      expect(options, id).not.toHaveProperty('defaultBrowserType');
    }
    expect(deviceContextOptions('phone-iphone')).toMatchObject({
      isMobile: true,
      hasTouch: true,
      screen: { width: 390, height: 844 },
    });
    expect(deviceContextOptions('tablet-ipad').screen).toEqual({ width: 810, height: 1080 });
    expect(deviceContextOptions('desktop')).toMatchObject({
      isMobile: false,
      viewport: { width: 1280, height: 900 },
    });
  });

  test('RUN_DEVICE selects the device, unknown values fall back to desktop', () => {
    expect(isDeviceId('phone-android')).toBe(true);
    expect(isDeviceId('fridge')).toBe(false);
    const previous = process.env.RUN_DEVICE;
    process.env.RUN_DEVICE = 'phone-android';
    expect(currentDevice()).toBe('phone-android');
    process.env.RUN_DEVICE = 'fridge';
    expect(currentDevice()).toBe('desktop');
    process.env.RUN_DEVICE = previous ?? '';
  });
});
