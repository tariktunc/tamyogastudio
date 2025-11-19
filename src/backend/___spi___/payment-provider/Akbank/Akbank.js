// backend/___spi___/payment-provider/Akbank/Akbank.js

function toCurrencyNumeric(code) {
  const c = String(code || 'TRY').toUpperCase();
  return c === 'TRY' ? '949' : c === 'USD' ? '840' : c === 'EUR' ? '978' : '949';
}
function trimBase(u){ return String(u || '').replace(/\/+$/, ''); }

/**
 * Provider giriş URL'sini üret:
 * /_functions/payRedirect?wixTxn=...&amountMinor=...&currency=... [&installCount] [&successUrl&errorUrl&cancelUrl&pendingUrl]
 */
function buildProviderUrl(options) {
  const base = trimBase(options?.merchantCredentials?.callbackBaseUrl);
  if (!base) {
    return { err: { reasonCode: 6000, errorCode: 'CONFIG_ERROR', errorMessage: 'callbackBaseUrl missing' } };
  }

  const wixTxnId    = String(options?.wixTransactionId || '');
  const amountMinor = Number(options?.order?.description?.totalAmount || 0);
  const currency    = toCurrencyNumeric(options?.order?.currency);

  // Opsiyonel: taksit
  const inst = Number(
    (options && options.order && options.order.paymentMethod && options.order.paymentMethod.installments) ??
    (options && options.order && options.order.customFields && options.order.customFields.installments) ?? 0
  );

  // Wix returnUrls (passthrough)
  const ru = options?.order?.returnUrls || {};
  const successUrl = ru?.successUrl ? String(ru.successUrl) : '';
  const errorUrl   = ru?.errorUrl   ? String(ru.errorUrl)   : '';
  const cancelUrl  = ru?.cancelUrl  ? String(ru.cancelUrl)  : '';
  const pendingUrl = ru?.pendingUrl ? String(ru.pendingUrl) : '';

  let qs = `?wixTxn=${encodeURIComponent(wixTxnId)}&amountMinor=${amountMinor}&currency=${currency}`;
  if (Number.isFinite(inst) && inst > 0) qs += `&installCount=${encodeURIComponent(String(inst))}`;
  if (successUrl) qs += `&successUrl=${encodeURIComponent(successUrl)}`;
  if (errorUrl)   qs += `&errorUrl=${encodeURIComponent(errorUrl)}`;
  if (cancelUrl)  qs += `&cancelUrl=${encodeURIComponent(cancelUrl)}`;
  if (pendingUrl) qs += `&pendingUrl=${encodeURIComponent(pendingUrl)}`;

  const url = `${base}/_functions/payRedirect${qs}`;
  return { url, wixTxnId };
}

// Modül yüklenince export setini logla (debug)
try { console.log('AKBANK exports (pre):', Object.keys(module.exports || {})); } catch (e) {}

export const connectAccount = async (options) => {
  const out = {
    accountId: 'Akbank',
    credentials: { callbackBaseUrl: options?.credentials?.callbackBaseUrl || '' }
  };
  console.log('AKBANK connectAccount out', out);
  return out;
};

/**
 * Gelecek uyumluluk: createCheckoutSession (kullanılmıyor olabilir)
 * Şeması Wix'e uygundur ama platform createTransaction yolunu kullanıyorsa çağrılmaz.
 */
export const createCheckoutSession = async (options) => {
  try {
    console.log('AKBANK createCheckoutSession in', {
      wixTransactionId: options?.wixTransactionId,
      currency: options?.order?.currency,
      totalAmountMinor: options?.order?.description?.totalAmount
    });
    const r = buildProviderUrl(options);
    if (r.err) { console.log('AKBANK createCheckoutSession out', r.err); return r.err; }
    const out = {
      pluginTransactionId: r.wixTxnId,
      checkoutSession: { type: 'REDIRECT', redirect: { url: r.url, method: 'GET' } }
    };
    console.log('AKBANK createCheckoutSession out', out);
    return out;
  } catch (e) {
    console.error('AKBANK createCheckoutSession error', e);
    return { reasonCode: 6000, errorCode: 'GENERAL_ERROR', errorMessage: 'Checkout session init failed' };
  }
};

/**
 * ESAS AKIŞ: createTransaction (redirection-based)
 * Dönüş Şeması (Wix docs): { pluginTransactionId, redirectUrl }
 * Ek alan YOK. (checkoutSession YOK.)
 */
export const createTransaction = async (options) => {
  try {
    console.log('AKBANK createTransaction in', {
      wixTransactionId: options?.wixTransactionId,
      totalAmountMinor: String(options?.order?.description?.totalAmount || ''),
      hasReturnUrls: !!options?.order?.returnUrls
    });

    const r = buildProviderUrl(options);
    if (r.err) { console.log('AKBANK createTransaction out', r.err); return r.err; }

    const out = { pluginTransactionId: r.wixTxnId, redirectUrl: r.url };
    console.log('AKBANK createTransaction out', out);
    return out;
  } catch (e) {
    console.error('AKBANK createTransaction error', e);
    return { reasonCode: 6000, errorCode: 'GENERAL_ERROR', errorMessage: 'Transaction init failed' };
  }
};

export const refundTransaction = async (_options) => {
  const out = { reasonCode: 6001, errorCode: 'REFUND_NOT_SUPPORTED', errorMessage: 'Refund not configured' };
  console.log('AKBANK refundTransaction out', out);
  return out;
};

// Yükleme sonrası exportları logla
try { console.log('AKBANK exports (post):', Object.keys(module.exports || {})); } catch (e) {}
