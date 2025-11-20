// backend/garanti-service.js

import { ok, badRequest } from 'wix-http-functions';
import wixPaymentProviderBackend from 'wix-payment-provider-backend';
import crypto from 'crypto';

// =======================================================
// SABİT CALLBACK BASE (Akbank ile aynı yapı)
// =======================================================
const CALLBACK_BASE = 'https://www.tamyogastudio.com';

// =======================================================
// HTML TEMPLATE
// =======================================================
function htmlPage({ title = 'Ödeme', bodyInner = '' } = {}) {
  return `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${String(title)}</title>
<link rel="stylesheet" href="/_functions/paycss"></head>
<body id="garanti-body"><div class="wrap" id="garanti-wrap">${bodyInner}</div></body></html>`;
}

// =======================================================
// BANKA HASH FONKSİYONU
// =======================================================
function hmacSha1Hex(msg, key) {
  return crypto.createHmac('sha1', key).update(msg, 'utf8').digest('hex');
}

// =======================================================
// GARANTI HASH OLUŞTURMA
// =======================================================
function generateHash({
  terminalId,
  orderId,
  amount,
  successUrl,
  errorUrl,
  storeKey,
}) {
  const plain =
    terminalId +
    orderId +
    amount +
    successUrl +
    errorUrl +
    storeKey;

  return hmacSha1Hex(plain, storeKey).toUpperCase();
}

// =======================================================
// 1) REDIRECT -> Kullanıcı bankaya yönlendirilir
// =======================================================
export async function redirect(request) {
  try {
    const query = request.query;
    const wixTxn = String(query.wixTxn || '').trim();
    const amountMinor = String(query.amountMinor || '').trim();
    const currency = String(query.currency || '').trim();

    if (!wixTxn || !amountMinor || !currency) {
      console.warn('GARANTI redirect eksik parametre');
      return badRequest('Eksik parametre');
    }

    // Ödeme oluştur
    await wixPaymentProviderBackend.PaymentOnboarding.markTransactionAsRedirected(
      wixTxn
    );

    // Müşteri IP (Akbank ile paralel)
    const clientIp = request.headers['x-forwarded-for'] || '';

    // BANKA sabit bilgileri (Wix Secrets değil - senin kurduğun wrapper)
    const { GARANTI_STORE_KEY, GARANTI_TERMINAL_ID, GARANTI_PROV_USER, GARANTI_PROV_PASSWORD, GARANTI_MERCHANT_ID } =
      (await import('./garanti-config.js')).default;

    const orderId = wixTxn.replace(/-/g, '').toUpperCase().slice(0, 20);

    const successUrl = `${CALLBACK_BASE}/_functions/garantiCallback?wixTransactionId=${wixTxn}`;
    const errorUrl = `${CALLBACK_BASE}/_functions/garantiCallback?wixTransactionId=${wixTxn}`;

    const secureHash = generateHash({
      terminalId: GARANTI_TERMINAL_ID,
      orderId,
      amount: amountMinor,
      successUrl,
      errorUrl,
      storeKey: GARANTI_STORE_KEY,
    });

    const html = htmlPage({
      title: 'Garanti Ödeme Yönlendirme',
      bodyInner: `
      <form id="garantiForm" method="post" action="https://sanalposprov.garanti.com.tr/servlet/gt3dv2">
        <input type="hidden" name="clientid" value="${GARANTI_TERMINAL_ID}">
        <input type="hidden" name="orderid" value="${orderId}">
        <input type="hidden" name="txnamount" value="${amountMinor}">
        <input type="hidden" name="txncurrencycode" value="${currency}">
        <input type="hidden" name="successurl" value="${successUrl}">
        <input type="hidden" name="errorurl" value="${errorUrl}">
        <input type="hidden" name="secure3dhash" value="${secureHash}">
      </form>
      <script>document.getElementById('garantiForm').submit();</script>
      `,
    });

    return ok(html);
  } catch (e) {
    console.error('Garanti redirect ERROR:', e);
    return badRequest('Redirect oluşturulamadı');
  }
}

// =======================================================
// 2) CALLBACK (POST) -> Bankadan dönüş
// =======================================================
export async function callback(request) {
  try {
    const body = request.body || {};
    const params = typeof body === 'object' ? body : {};

    console.log('post_garantiCallback (Normalized) received:', JSON.stringify(params));

    const wixTxn = params['wixTransactionId']
      ? String(params['wixTransactionId'])
      : '';

    const mdstatus = String(params['mdstatus'] || '').trim();
    const procreturncode = String(params['procreturncode'] || '').trim();
    const orderId = String(params['orderid'] || '').trim();

    if (!wixTxn || !orderId) {
      console.warn('[CALLBACK] Eksik parametre. İşlem reddedildi.');
      return ok(autoCloseHtml({ redirect: '/' }));
    }

    const approved = mdstatus === '1' && procreturncode === '00';

    if (approved) {
      console.info(`Transaction Approval: true (OrderID: ${orderId})`);
      await wixPaymentProviderBackend.PaymentOnboarding.markTransactionAsApproved(
        wixTxn
      );
      return ok(autoCloseHtml({ redirect: '/' }));
    } else {
      console.warn(
        `Failed Transaction (oid: ${orderId}). Reason: MD: ${mdstatus}, Code: ${procreturncode}`
      );
      await wixPaymentProviderBackend.PaymentOnboarding.markTransactionAsDeclined(
        wixTxn,
        'Garanti Red'
      );
      return ok(autoCloseHtml({ redirect: '/' }));
    }
  } catch (e) {
    console.error('Callback Error:', e);
    return badRequest('Callback okunamadı');
  }
}

// =======================================================
// AUTO CLOSE HTML (aynı Akbank yapısı)
// =======================================================
function autoCloseHtml({ redirect = '/' } = {}) {
  const safe = String(redirect || '/');
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PENCEREYİ KAPATIN</title><link rel="stylesheet" href="/_functions/paycss"></head><body id="garanti-body"><div class="wrap" id="garanti-wrap"><div class="card" id="garanti-card-alert" role="alert" aria-live="polite"><h2 id="garanti-close-title">PENCEREYİ KAPATIN</h2></div></div><script>try{try{if(window.opener&&!window.opener.closed)window.opener.postMessage({type:'GARANTI_PAYMENT_DONE'}, '*');}catch(e){}try{if(window.opener&&!window.opener.closed)window.opener.location.reload();}catch(e){}setTimeout(function(){try{window.close();}catch(e){}},800);}catch(e){}</script><noscript><meta http-equiv="refresh" content="0;url=${safe}"></noscript></body></html>`;
}
