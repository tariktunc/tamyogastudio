// backend/garanti-service.js
import { ok, badRequest } from 'wix-http-functions';
import { getSecret } from 'wix-secrets-backend';
import wixPaymentProviderBackend from 'wix-payment-provider-backend';

import {
  buildPayHostingForm as buildGarantiForm,
  verifyCallbackHash as verifyGarantiHash,
  isApproved as isGarantiApproved
} from 'backend/garanti-vpg-wrapper';

// HTML helper
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

// Redirect parent
function redirectOnlyHtmlTop(target) {
  const safe = String(target || '/');
  return `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Yönlendiriliyor...</title>
<link rel="stylesheet" href="/_functions/paycss">
</head>
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

// Auto close window
function autoCloseHtml({ redirect = '/' } = {}) {
  const safe = String(redirect || '/');
  return `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PENCEREYİ KAPATIN</title>
<link rel="stylesheet" href="/_functions/paycss">
</head>
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
// GARANTI REDIRECT HANDLER - get_garantiRedirect
// =================================================================
export async function redirect(request) {
  try {
    const { wixTxn: wixTxnRaw, amountMinor, currency } = request.query;
    console.log('get_garantiRedirect in', { wixTxnRaw, amountMinor, currency });

    if (!wixTxnRaw || !amountMinor || !(Number(amountMinor) > 0)) {
      return badRequest({ headers: { 'Content-Type': 'text/plain' }, body: 'missing or invalid params' });
    }

    const customerIp = request.ip;
    console.log(`INFO: Musteri IP adresi alindi: ${customerIp}`);

    // Callback base secret
    const callbackBase = await getSecret('GARANTI_CALLBACK_BASE_URL');
    if (!callbackBase) {
      console.error('get_garantiRedirect: KRITIK HATA! GARANTI_CALLBACK_BASE_URL secret eksik!');
      const errHtml = `
            <div class="card" id="akb-card-alert" role="alert" aria-live="assertive">
              <h1 id="akb-title-alert">Ayar Hatası (Garanti)</h1>
              <p class="note">Garanti ile bağlantı kurulamadı. Lütfen 'GARANTI_CALLBACK_BASE_URL' secret değerini kontrol edin.</p>
              <div class="actions" id="akb-actions-alert"><a class="btn" href="/" id="akb-alert-home">Ana sayfa</a></div>
            </div>`;
      return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: htmlPage({ title: 'Ayar Hatası', bodyInner: errHtml }) });
    }

    console.log(`INFO: garantiCallbackBase resolved successfully to: ${callbackBase}`);

    // Wix return URLs
    const successUrl = request.query.successUrl ? String(request.query.successUrl) : '';
    const errorUrl   = request.query.errorUrl   ? String(request.query.errorUrl)   : '';
    const cancelUrl  = request.query.cancelUrl  ? String(request.query.cancelUrl)  : '';
    const pendingUrl = request.query.pendingUrl ? String(request.query.pendingUrl) : '';

    // Query string to pass back to Wix
    const ruQS =
      (successUrl ? `&successUrl=${encodeURIComponent(successUrl)}` : '') +
      (errorUrl   ? `&errorUrl=${encodeURIComponent(errorUrl)}`     : '') +
      (cancelUrl  ? `&cancelUrl=${encodeURIComponent(cancelUrl)}`   : '') +
      (pendingUrl ? `&pendingUrl=${encodeURIComponent(pendingUrl)}` : '');

    const orderId = (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 28).toUpperCase();

    // Internal callbacks
    const baseTrimmed = String(callbackBase).replace(/\/+$/, '');
    const okUrl   = `${baseTrimmed}/_functions/garantiCallback?wixTransactionId=${encodeURIComponent(wixTxnRaw)}${ruQS}`;
    const failUrl = `${baseTrimmed}/_functions/garantiCallback?wixTransactionId=${encodeURIComponent(wixTxnRaw)}${ruQS}`;

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

    // Taksit seçimi ekranı
    if (!installCount) {
      const escapedWixTxn = String(wixTxnRaw).replace(/"/g, '&quot;');
      const escapedAmountMinor = String(amountMinor).replace(/"/g, '&quot;');
      const escapedCurrency = String(currency || '').replace(/"/g, '&quot;');

      const optionsHtml = allowedInstallments
        .map(n => `<option value="${n}">${n === 1 ? 'Peşin Ödeme' : (n + ' taksit')}</option>`)
        .join('');

      const submitBtnLabel = allowedInstallments.length === 1 ? 'ONAYLA' : 'Ödemeye Geç';

      const selectionHtml = `
            <div class="card" id="akb-card-selection" role="main" aria-label="Taksit Seçim">
              <h1 id="akb-title-selection">Ödeme Bilgileri (Garanti)</h1>
              <div class="row" id="akb-row-amount"><div class="label">Tutar:</div><div class="amount" id="akb-amount">${amount} TL</div></div>
              <form id="akb-form-select" method="GET" action="/_functions/garantiRedirect" target="_self" aria-label="Taksit seçim formu">
                <input type="hidden" name="wixTxn" value="${escapedWixTxn}">
                <input type="hidden" name="amountMinor" value="${escapedAmountMinor}">
                <input type="hidden" name="currency" value="${escapedCurrency}">
                ${successUrl ? `<input type="hidden" name="successUrl" value="${String(successUrl).replace(/"/g,'&quot;')}">` : ''}
                ${errorUrl   ? `<input type="hidden" name="errorUrl"   value="${String(errorUrl).replace(/"/g,'&quot;')}">` : ''}
                ${cancelUrl  ? `<input type="hidden" name="cancelUrl"  value="${String(cancelUrl).replace(/"/g,'&quot;')}">` : ''}
                ${pendingUrl ? `<input type="hidden" name="pendingUrl" value="${String(pendingUrl).replace(/"/g,'&quot;')}">` : ''}

                <div class="row" id="akb-row-install">
                    <label class="label" for="akb-install">Taksit Seçimi</label>
                    <select id="akb-install" name="installCount" class="select" aria-label="Taksit seçimi">
                        ${optionsHtml}
                    </select>
                </div>
                <div class="actions" id="akb-actions-select">
                    <button type="submit" class="btn btn-primary" id="akb-select-submit" aria-label="${submitBtnLabel}">${submitBtnLabel}</button>
                    <a href="/" class="btn" id="akb-select-cancel" target="_self" rel="noopener" aria-label="İptal">İptal</a>
                </div>
              </form>
            </div>`;
      return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: htmlPage({ title: 'Ödeme - Taksit Seçimi (Garanti)', bodyInner: selectionHtml }) });
    }

    const installStr = installCount > 1 ? String(installCount) : '';

    const { actionUrl, formFields } = await buildGarantiForm({
      orderId,
      amountMinor,
      currency,
      okUrl,
      failUrl,
      customerIp,
      installments: installStr
    });

    const inputs = Object.entries(formFields)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v ?? '').replace(/"/g, '&quot;')}">`)
      .join('\n');

    const monthly = (Number(amount) / Number(installCount)).toFixed(2);

    const confirmHtml = `
        <div class="card" id="akb-card-confirm" role="main" aria-label="Taksit Onay">
        <h1 id="akb-title-confirm">Taksit Onayı (Garanti)</h1>
        <div class="row" id="akb-row-amount-confirm"><div class="label">Tutar:</div><div class="amount" id="akb-amount-confirm">${amount} TL</div></div>
        <div class="row" id="akb-row-install-confirm"><div class="label">Seçilen Taksit:</div><div id="akb-install-chosen">${installCount} ${installCount > 1 ? 'taksit' : 'Peşin'}</div></div>
        <div class="row" id="akb-row-monthly"><div class="label">Her taksit tutarı:</div><div id="akb-monthly">${monthly} TL</div></div>
          <p class="note" id="akb-note">Onay sonrası Garanti BBVA'ya yönlendirileceksiniz.</p>
        <div class="actions" id="akb-actions-confirm">
          <a href="/" class="btn" id="akb-confirm-cancel" target="_self" rel="noopener" aria-label="İptal">İptal</a>
          <button id="akb-submit" type="submit" form="akb-form" class="btn btn-primary" aria-label="Onayla ve Bankaya Git">Onayla ve Bankaya Git</button>
        </div>
      </div>
      <form id="akb-form" method="POST" action="${actionUrl}" target="_self" aria-label="Bankaya yönlendirme formu">
          ${inputs}
      </form>
      <script>
      (function(){
        var f=document.getElementById('akb-form');
        var btn=document.getElementById('akb-submit');
        var sent=false;
        if(!f||!btn)return;
        f.addEventListener('submit',function(e){
            if(sent){e.preventDefault();return;}
            sent=true;
            try{btn.setAttribute('disabled','disabled');btn.textContent='Yönlendiriliyor…';}catch(e){}
        },false);
        btn.addEventListener('click',function(){ try{ f.requestSubmit ? f.requestSubmit() : f.submit(); }catch(e){} });
        var cancelLinks=document.querySelectorAll('a[aria-label="İptal"]');
        cancelLinks.forEach(function(a){ a.addEventListener('click', function(){ sent=true; }); });
      })();
      </script>
    `;

    console.info('get_garantiRedirect: Bankaya Gonderilen Form Verisi', formFields);

    return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: htmlPage({ title: 'Taksit Onayı (Garanti)', bodyInner: confirmHtml }) });
  } catch (e) {
    console.error('get_garantiRedirect fatal', e);
    const errHtml = `
        <div class="card" id="akb-card-alert" role="alert" aria-live="assertive">
            <h1 id="akb-title-alert">Hata</h1>
            <p class="note">Garanti BBVA bağlantı/ayar hatası: ${String(e.message)}</p>
            <div class="actions" id="akb-actions-alert"><a class="btn" href="/" id="akb-alert-home">Ana sayfa</a></div>
        </div>`;
    return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: htmlPage({ title: 'Garanti Hata', bodyInner: errHtml }) });
  }
}

// =================================================================
// GARANTI CALLBACK HANDLER - post_garantiCallback
// =================================================================
export async function callback(request) {
  try {
    // 1. Parse body
    let post = {};
    try {
      const raw = await request.body.text();
      post = Object.fromEntries(new URLSearchParams(raw || ''));
    } catch (e) {
      console.error('Garanti Callback Parse Error:', e);
      post = {};
    }

    // 2. Key normalize
    const normalizedPost = {};
    Object.keys(post).forEach(key => {
      normalizedPost[key.toLowerCase()] = post[key];
    });

    console.log('post_garantiCallback (Normalized) received:', normalizedPost);

    // IDs
    const wixTransactionId = request.query['wixTransactionId'] || normalizedPost.oid || '';
    const orderId = normalizedPost.oid || '';
    const amount = normalizedPost.amount || '';

    const successUrl = request.query.successUrl ? String(request.query.successUrl) : '';
    const errorUrl   = request.query.errorUrl   ? String(request.query.errorUrl)   : '';

    // 3. Hash verify
    let hashOk = false;
    try {
      hashOk = await verifyGarantiHash(normalizedPost);
    } catch (e) {
      console.error('post_garantiCallback verifyGarantiHash critical error:', e);
      hashOk = false;
    }

    console.log(`Hash Verification Result: ${hashOk}. (Order ID: ${orderId})`);
    if (!hashOk) console.warn('GARANTI CALLBACK: Hash mismatch or missing params.');

    // 4. Approval
    const approved = isGarantiApproved(normalizedPost);
    const hostCode = String(normalizedPost.procreturncode || '');
    const mdStatus = String(normalizedPost.mdstatus || '');
    const bankErrorMsg = String(normalizedPost.mderrormessage || normalizedPost.errmsg || 'İşlem banka tarafından reddedildi.');

    console.log(`Transaction Approval: ${approved} (MD: ${mdStatus}, Code: ${hostCode})`);

    // Success
    if (approved && hashOk) {
      try {
        if (wixTransactionId) {
          await wixPaymentProviderBackend.submitEvent({
            event: {
              transaction: {
                wixTransactionId,
                pluginTransactionId: normalizedPost.authcode || normalizedPost.retref || 'GARANTI_OOS'
              }
            }
          });
        }
      } catch (e) {
        console.warn('submitEvent error (ignored):', e);
      }

      const target = successUrl || `/odeme/basarili?wixTxn=${encodeURIComponent(wixTransactionId)}&orderId=${encodeURIComponent(orderId)}&amount=${encodeURIComponent(amount)}`;

      if (successUrl) {
        return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: redirectOnlyHtmlTop(target) });
      }
      return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: autoCloseHtml({ redirect: target }) });
    }

    // Fail
    const reason = `Hata Kodu: ${hostCode} / MD: ${mdStatus}. ${bankErrorMsg}` + (hashOk ? '' : ' (Hash Hatası!)');
    console.warn(`Failed Transaction (oid: ${orderId}). Reason: ${reason}`);

    const fallbackErr = `/odeme/basarisiz?host=${encodeURIComponent(hostCode)}&msg=${encodeURIComponent(reason)}&orderId=${encodeURIComponent(orderId)}`;
    const target = errorUrl || fallbackErr;

    if (errorUrl) {
      const errHtml = `
            <div class="card" id="akb-card-alert" role="alert" aria-live="assertive">
                <h1 id="akb-title-alert">Ödeme Başarısız</h1>
                <p class="note">Banka Yanıtı: ${bankErrorMsg}</p>
                <p class="note" style="font-size:0.8em; color:#666;">Kod: ${hostCode} | MD: ${mdStatus}</p>
                <div class="actions" id="akb-actions-alert">
                    <a class="btn" href="${target}" id="akb-alert-home">Devam Et</a>
                </div>
            </div>`;
      return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: htmlPage({ title: 'Ödeme Başarısız', bodyInner: errHtml }) });
    }

    return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: autoCloseHtml({ redirect: target }) });
  } catch (err) {
    console.error('post_garantiCallback fatal', err);
    const target = '/';
    return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: autoCloseHtml({ redirect: target }) });
  }
}
