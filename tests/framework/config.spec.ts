import { expect, test } from '@playwright/test';
import {
  ConfigurationError,
  assertSafeTargetUrl,
  getEnvironmentSettings,
  resolveEnvironment,
} from '@config/test-config';
import { SUPPORTED_ENVIRONMENTS } from '@app-types/config.types';

test.describe('Environment configuration', () => {
  test('supports exactly LOCAL and UAT', () => {
    expect([...SUPPORTED_ENVIRONMENTS]).toEqual(['local', 'uat']);
  });

  test('resolves environments case-insensitively and defaults to uat', () => {
    expect(resolveEnvironment('local')).toBe('local');
    expect(resolveEnvironment('LOCAL')).toBe('local');
    expect(resolveEnvironment(' UAT ')).toBe('uat');
    expect(resolveEnvironment('')).toBe('uat');
  });

  for (const value of ['prod', 'production', 'staging', 'qa', 'live']) {
    test(`rejects TEST_ENV="${value}"`, () => {
      expect(() => resolveEnvironment(value)).toThrow(ConfigurationError);
    });
  }

  test('exposes per-environment settings', () => {
    expect(getEnvironmentSettings('local').displayName).toBe('LOCAL');
    expect(getEnvironmentSettings('uat').allowDestructiveTests).toBe(false);
  });

  test('accepts LOCAL/UAT style URLs and strips trailing slashes', () => {
    expect(assertSafeTargetUrl('https://api.qa.example.com/v1/', 'X')).toBe(
      'https://api.qa.example.com/v1',
    );
    expect(assertSafeTargetUrl('https://uat-api.example.com', 'X')).toBe(
      'https://uat-api.example.com',
    );
    expect(assertSafeTargetUrl('http://localhost:8080/api', 'X')).toBe('http://localhost:8080/api');
    // "product" must not be confused with "prod"
    expect(assertSafeTargetUrl('https://product-api.qa.example.com', 'X')).toBe(
      'https://product-api.qa.example.com',
    );
  });

  for (const url of [
    'https://api.prod.example.com',
    'https://api-production.example.com',
    'https://live.example.com',
    'ftp://qa.example.com',
    'not a url',
  ]) {
    test(`rejects unsafe target URL ${url}`, () => {
      expect(() => assertSafeTargetUrl(url, 'UAT_API_BASE_URL')).toThrow(ConfigurationError);
    });
  }
});
