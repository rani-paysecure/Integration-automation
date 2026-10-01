/**
 * Keys whose values must never appear in logs or reports.
 * Matching is case-insensitive and ignores `-` and `_`
 * (so `client_secret`, `clientSecret` and `Client-Secret` all match).
 */
export const FULLY_MASKED_KEYS: readonly string[] = [
  // credentials & tokens
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authorization',
  'proxyauthorization',
  'apikey',
  'xapikey',
  'cookie',
  'setcookie',
  'signature',
  'privatekey',
  'usedauthkey',
  'authkey',
  'paymenthandletoken',
  'authcode',
  'pspauthcode',
  'csrf',
  'xcsrftoken',
  'xxsrftoken',
  'cardschemetransactionid',
  'holdername',
  'cardholdername',
  // payment credentials
  'cvv',
  'cvv2',
  'cvc',
  'securitycode',
  'pin',
  'expiry',
  'expirydate',
  'expmonth',
  'expirymonth',
  'expiryyear',
  'cardexpiry',
  'expires',
  'expyear',
  'track',
  'trackdata',
  // customer PII
  'ssn',
  'dateofbirth',
  'dob',
  'nationalid',
  'taxid',
];

/**
 * PSP payloads use their own key names (`banff_secret`, `merchantApiKey`,
 * `x_auth_token` …). Any key CONTAINING one of these fragments is fully masked.
 */
export const FULLY_MASKED_KEY_FRAGMENTS: readonly string[] = [
  'secret',
  'password',
  'passwd',
  'token',
  'apikey',
  'authkey',
  'privatekey',
  'signature',
  'cvv',
  'cvc',
];

/** Keys whose values are partially masked (last 4 characters kept). */
export const PARTIALLY_MASKED_KEYS: readonly string[] = [
  'cardnumber',
  'dcardnumber',
  'pan',
  'accountnumber',
  'iban',
  'phone',
  'phonenumber',
  'mobile',
  'msisdn',
  'beneficiarymsisdn',
];

/** Keys holding e-mail addresses (local part masked). */
export const EMAIL_KEYS: readonly string[] = ['email', 'emailaddress', 'customeremail'];

export const MASK = '***';
