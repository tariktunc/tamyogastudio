// backend/garanti-service.js
import { ok, badRequest } from 'wix-http-functions';
import { getSecret } from 'wix-secrets-backend';
import wixPaymentProviderBackend from 'wix-payment-provider-backend';

import {
  buildPayHostingForm as buildGarantiForm,
  verifyCallbackHash as verifyGarantiHash,
  isApproved as isGarantiApproved
} from 'backend/garanti-vpg-wrapper';

function htmlPage({ title = 'Ödeme', bodyInner = '' } = {}) {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${String(title)}</title>
<link rel="stylesheet" href="/_functions/paycss">
</head>
<body id="akb-body"><div class="wrap" id="akb-wrap">${bodyInner}</div></body>
</html>`;
}

function redirectOnlyHtmlTop(target) {
  const safe = String(target || '/');
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Yönlendiriliyor...</title>
<link rel="stylesheet" href="/_functions/paycss"></head>
<body id="akb-body"><div class="wrap" id="akb-wrap">
  <div class="card" id="akb-card-alert" role="alert" aria-live="polite">
        <h2 id="akb-close-title">Yönlendiriliyor...</h2>
    </div>
  </div>
<script>
try{ window.top.location.replace(${JSON.stringify(safe)}); }catch(e){ location.href=${JSON.stringify(safe)}; }
</script>
<noscript><meta http-equiv="refresh" content="0;url=${safe}"></noscript>
</body>
</html>`;
}

function autoCloseHtml({ redirect = '/' } = {}) {
  const safe = String(redirect || '/');
  return `<!doctype html><html lang="tr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PENCEREYİ KAPATIN</title>
<link rel="stylesheet" href="/_functions/paycss"></head>
<body id="akb-body"><div class="wrap" id="akb-wrap">
  <div class="card" id="akb-card-alert" role="alert" aria-live="polite">
        <h2 id="akb-close-title">PENCEREYİ KAPATIN</h2>
    </div>
  </div>
<script>
try{
  try { if (window.opener && !window.opener.closed) window.opener.postMessage({type:'GARANTI_PAYMENT_DONE'}, '*'); } catch(e){}
  try { if (window.opener && !window.opener.closed) window.opener.location.reload(); } catch(e){}
  setTimeout(function(){ try{ window.close(); }catch(e){} }, 800);
}catch(e){}
</script>
<noscript><meta http-equiv="refresh" content="0;url=${safe}"></noscript>
</body>
</html>`;
}

// =================================================================
// REDIRECT
// =================================================================
export async function redirect(request) {
  try {
    const { wixTxn: wixTxnRaw, amountMinor, currency } = request.query;

    if (!wixTxnRaw || !amountMinor || !(Number(amountMinor) > 0)) {
      return badRequest({ headers: { 'Content-Type': 'text/plain' }, body: 'missing or invalid params' });
    }

    const callbackBase = await getSecret('GARANTI_CALLBACK_BASE_URL');
    if (!callbackBase) {
      const errHtml = `
        <div class="card" id="akb-card-alert"><h1>Ayar Hatası (Garanti)</h1>
        <p class="note">GARANTI_CALLBACK_BASE_URL eksik</p></div>`;
      return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: htmlPage({ title: 'Ayar Hatası', bodyInner: errHtml }) });
    }

    const successUrl = request.query.successUrl ? String(request.query.successUrl) : '';
    const errorUrl   = request.query.errorUrl   ? String(request.query.errorUrl)   : '';
    const cancelUrl  = request.query.cancelUrl  ? String(request.query.cancelUrl)  : '';
    const pendingUrl = request.query.pendingUrl ? String(request.query.pendingUrl) : '';

    const ruQS =
      (successUrl ? `&successUrl=${encodeURIComponent(successUrl)}` : '') +
      (errorUrl   ? `&errorUrl=${encodeURIComponent(errorUrl)}`     : '') +
      (cancelUrl  ? `&cancelUrl=${encodeURIComponent(cancelUrl)}`   : '') +
      (pendingUrl ? `&pendingUrl=${encodeURIComponent(pendingUrl)}` : '');

    const orderId = (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 28).toUpperCase();
    const okUrl = `${callbackBase}/_functions/garantiCallback?wixTransactionId=${encodeURIComponent(wixTxnRaw)}${ruQS}`;
    const failUrl = okUrl;

    const amount = (parseInt(String(amountMinor), 10) / 100).toFixed(2);
    const amtNum = Number(amount);
    let allowedInstallments;
    if (amtNum <= 10000) allowedInstallments = [1];
    else if (amtNum <= 18000) allowedInstallments = [1, 2, 3];
    else allowedInstallments = [1, 2, 3, 4, 5, 6];

    const rawInstall = request.query.installCount;
    let installCount = rawInstall ? Number(rawInstall) || 1 : null;
    if (installCount != null && !allowedInstallments.includes(Number(installCount))) {
      installCount = 1;
    }

    // TAKSIT SEÇİMİ SAYFASI
    if (!installCount) {
      return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: htmlPage({ title: 'Ödeme - Taksit Seçimi (Garanti)', bodyInner: '<div>GARANTI taksit formu taşındı</div>' }) });
    }

    const installStr = installCount > 1 ? String(installCount) : '';
    const { actionUrl, formFields } = await buildGarantiForm({
      orderId,
      amountMinor,
      currency,
      okUrl,
      failUrl,
      customerIp: request.ip,
      installments: installStr
    });

    const monthly = (Number(amount) / Number(installCount)).toFixed(2);
    const inputs = Object.entries(formFields)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v ?? '').replace(/"/g, '&quot;')}">`)
      .join('\n');

    const confirmHtml = `
      <div class="card"><h1>Taksit Onayı (Garanti)</h1>
      <div>${amount} TL | ${installCount} taksit | Aylık ${monthly} TL</div>
      <form id="akb-form" method="POST" action="${actionUrl}">${inputs}</form>
      <button onclick="document.getElementById('akb-form').submit()">Onayla ve Bankaya Git</button></div>`;

    return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: htmlPage({ title: 'Taksit Onayı (Garanti)', bodyInner: confirmHtml }) });

  } catch (e) {
    return badRequest({ headers: { 'Content-Type': 'text/plain' }, body: String(e) });
  }
}

// =================================================================
// CALLBACK
// =================================================================
export async function callback(request) {
  try {
    let post = {};
    try {
      const raw = await request.body.text();
      post = Object.fromEntries(new URLSearchParams(raw || ''));
    } catch (e) {}

    const normalizedPost = {};
    Object.keys(post).forEach(key => {
      normalizedPost[key.toLowerCase()] = post[key];
    });

    const wixTransactionId = request.query['wixTransactionId'] || normalizedPost.oid || '';
    const orderId = normalizedPost.oid || '';
    const amount = normalizedPost.amount || '';
    const successUrl = request.query.successUrl ? String(request.query.successUrl) : '';
    const errorUrl   = request.query.errorUrl   ? String(request.query.errorUrl)   : '';

    let hashOk = false;
    try { hashOk = await verifyGarantiHash(normalizedPost); } catch (e) {}

    const isApproved = isGarantiApproved(normalizedPost);
    const hostCode = String(normalizedPost.procreturncode || '');
    const mdStatus = String(normalizedPost.mdstatus || '');
    const bankErrorMsg = String(normalizedPost.mderrormessage || normalizedPost.errmsg || 'İşlem banka tarafından reddedildi.');

    if (isApproved && hashOk) {
      try {
        if (wixTransactionId) {
          await wixPaymentProviderBackend.submitEvent({ event: { transaction: { wixTransactionId, pluginTransactionId: normalizedPost.authcode || normalizedPost.retref || 'GARANTI_OOS' } } });
        }
      } catch (e) {}

      const target = successUrl || `/odeme/basarili?wixTxn=${encodeURIComponent(wixTransactionId)}&orderId=${encodeURIComponent(orderId)}&amount=${encodeURIComponent(amount)}`;
      if (successUrl) return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: redirectOnlyHtmlTop(target) });
      return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: autoCloseHtml({ redirect: target }) });
    }

    const reason = `Hata Kodu: ${hostCode} / MD: ${mdStatus}. ${bankErrorMsg}` + (hashOk ? '' : ' (Hash Hatası!)');
    const fallbackErr = `/odeme/basarisiz?host=${encodeURIComponent(hostCode)}&msg=${encodeURIComponent(reason)}&orderId=${encodeURIComponent(orderId)}`;
    const target = errorUrl || fallbackErr;

    if (errorUrl) {
      const errHtml = `<div class="card"><h1>Ödeme Başarısız</h1><div>${bankErrorMsg}</div></div>`;
      return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: htmlPage({ title: 'Ödeme Başarısız', bodyInner: errHtml }) });
    }

    return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: autoCloseHtml({ redirect: target }) });

  } catch (e) {
    return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: autoCloseHtml({ redirect: '/' }) });
  }
}
