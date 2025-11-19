// backend/http-functions.js
import { ok, badRequest } from 'wix-http-functions';
import { getSecret } from 'wix-secrets-backend';
import wixPaymentProviderBackend from 'wix-payment-provider-backend';
import crypto from 'crypto';
import { PAY_CSS } from 'public/pay-css.js';

// Garanti Wrapper Imports
import { buildPayHostingForm as buildGarantiForm, verifyCallbackHash as verifyGarantiHash, isApproved as isGarantiApproved } from 'backend/garanti-vpg-wrapper';


// HTML Helper: Basic Page Structure
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

export function get_paycss() {
  return ok({
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=86400'
    },
    body: PAY_CSS
  });
}

// --- Akbank Crypto Helpers ---
const hmacBase64Sha512 = (plain, key) =>
  crypto.createHmac('sha512', key).update(plain, 'utf8').digest('base64');

const randomHex128 = () => crypto.randomBytes(64).toString('hex').toUpperCase();

function nowIsoMs() {
  const d = new Date(), p2 = n => String(n).padStart(2, '0'), p3 = n => String(n).padStart(3, '0');
  return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
}

function buildRequestHash(f, secretKey) {
  const plain =
    String(f.paymentModel ?? '') +
    String(f.txnCode ?? '') +
    String(f.merchantSafeId ?? '') +
    String(f.terminalSafeId ?? '') +
    String(f.orderId ?? '') +
    String(f.lang ?? '') +
    String(f.amount ?? '') +
    String(f.ccbRewardAmount ?? '') +
    String(f.pcbRewardAmount ?? '') +
    String(f.xcbRewardAmount ?? '') +
    String(f.currencyCode ?? '') +
    String(f.installCount ?? '') +
    String(f.okUrl ?? '') +
    String(f.failUrl ?? '') +
    String(f.emailAddress ?? '') +
    String(f.mobilePhone ?? '') +
    String(f.homePhone ?? '') +
    String(f.workPhone ?? '') +
    String(f.randomNumber ?? '') +
    String(f.requestDateTime ?? '') +
    String(f.b2bIdentityNumber ?? '') +
    String(f.merchantData ?? '') +
    String(f.merchantBranchNo ?? '') +
    String(f.mobileEci ?? '') +
    String(f.walletProgramData ?? '') +
    String(f.mobileAssignedId ?? '') +
    String(f.mobileDeviceType ?? '');
  return hmacBase64Sha512(plain, secretKey);
}

async function verifyResponseHash(map) {
  try {
    const secretKey =
      (await getSecret('AKBANK_VPG_SECRET_KEY')) ||
      (await getSecret('AKBANK_STORE_KEY')) ||
      (await getSecret('AKBANK_SAFE_KEY')) || '';
    if (!secretKey) {
      console.warn('verifyResponseHash: secretKey not found');
      return false;
    }
    const rawParams = String(map.hashParams || '');
    if (!rawParams) {
      console.warn('verifyResponseHash: hashParams missing in post body');
      return false;
    }
    const params = rawParams.split('+').filter(Boolean);
    let plain = '';
    for (const p of params) plain += String(map[p] ?? '');
    const expected = hmacBase64Sha512(plain, secretKey);
    const ok = expected === String(map.hash || '');
    if (!ok) console.warn('verifyResponseHash: mismatch', { expected, got: map.hash });
    return ok;
  } catch (e) {
    console.error('verifyResponseHash error', e);
    return false;
  }
}

function mapHostMsg(code) {
  const m = {
    '05': 'İşlem reddedildi.',
    '12': 'Geçersiz işlem.',
    '13': 'Geçersiz tutar.',
    '14': 'Geçersiz kart numarası.',
    '51': 'Yetersiz bakiye/limit.',
    '54': 'Süresi dolmuş kart.',
    '55': 'Hatalı CVV/şifre.',
    '57': 'İşleme izin yok.',
    '61': 'Yetersiz bakiye.',
    '91': 'Banka sistemi ulaşılamıyor.'
  };
  return m[code] || 'Ödeme başarısız.';
}

// HTML Helper: Redirect Parent (for Success/Error pages)
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

// HTML Helper: Auto Close Window (for Popups)
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
  try { if (window.opener && !window.opener.closed) window.opener.postMessage({type:'AKBANK_PAYMENT_DONE'}, '*'); } catch(e){}
  try { if (window.opener && !window.opener.closed) window.opener.location.reload(); } catch(e){}
  setTimeout(function(){ try{ window.close(); }catch(e){} }, 800);
}catch(e){}
</script>
<noscript><meta http-equiv="refresh" content="0;url=${safe}"></noscript>
</body>
</html>`;
}


// =================================================================
// AKBANK REQUEST HANDLER
// =================================================================
export async function get_payRedirect(request) {
  try {
    const { wixTxn: wixTxnRaw, amountMinor, currency } = request.query;
    console.log('get_payRedirect (Akbank VPG) in', {
        wixTxnRaw, amountMinor, currency,
        hasReturnUrls: !!(request.query.successUrl || request.query.errorUrl || request.query.cancelUrl || request.query.pendingUrl)
    });

    if (!wixTxnRaw || !amountMinor) {
        return badRequest({ headers: { 'Content-Type': 'text/plain' }, body: 'missing params' });
    }
    if (!(Number(amountMinor) > 0)) {
        return badRequest({ headers: { 'Content-Type': 'text/plain' }, body: 'amount must be > 0' });
    }

    const merchantSafeId = await getSecret('AKBANK_MERCHANT_SAFE_ID');
    const terminalSafeId = await getSecret('AKBANK_TERMINAL_SAFE_ID');
    const secretKey =
        (await getSecret('AKBANK_VPG_SECRET_KEY')) ||
        (await getSecret('AKBANK_STORE_KEY')) ||
        (await getSecret('AKBANK_SAFE_KEY')) || '';
    const vpgBase =
        (await getSecret('AKBANK_VPG_BASE')) ||
        (await getSecret('AKBANK_GATEWAY_BASE')) || '';

    if (!merchantSafeId || !terminalSafeId || !secretKey || !vpgBase) {
        const missing = { AKBANK_MERCHANT_SAFE_ID: !!merchantSafeId, AKBANK_TERMINAL_SAFE_ID: !!terminalSafeId, AKBANK_VPG_SECRET_KEY: !!secretKey, AKBANK_VPG_BASE: !!vpgBase };
        console.error('get_payRedirect missing secrets', missing);
        const errHtml = `
        <div class="card" id="akb-card-alert" role="alert" aria-live="assertive">
            <h1 id="akb-title-alert">Ayar Hatası</h1>
            <p class="note">Akbank ile bağlantı kurulamadı. Lütfen secret değerlerini kontrol edin.</p>
            <pre class="note" id="akb-missing">${JSON.stringify(missing, null, 2)}</pre>
            <div class="actions" id="akb-actions-alert"><a class="btn" href="/" id="akb-alert-home">Ana sayfa</a></div>
        </div>`;
        return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: htmlPage({ title: 'Ayar Hatası', bodyInner: errHtml }) });
    }

    const actionUrl = `${String(vpgBase).replace(/\/+$/, '')}/payhosting`;
    const orderId = (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 28).toUpperCase();
    const amount = (parseInt(String(amountMinor), 10) / 100).toFixed(2);
    const currencyCode = Number(currency || 949);

    const successUrl = request.query.successUrl ? String(request.query.successUrl) : '';
    const errorUrl   = request.query.errorUrl   ? String(request.query.errorUrl)   : '';
    const cancelUrl  = request.query.cancelUrl  ? String(request.query.cancelUrl)  : '';
    const pendingUrl = request.query.pendingUrl ? String(request.query.pendingUrl) : '';
    const ruQS =
        (successUrl ? `&successUrl=${encodeURIComponent(successUrl)}` : '') +
        (errorUrl   ? `&errorUrl=${encodeURIComponent(errorUrl)}`     : '') +
        (cancelUrl  ? `&cancelUrl=${encodeURIComponent(cancelUrl)}`   : '') +
        (pendingUrl ? `&pendingUrl=${encodeURIComponent(pendingUrl)}` : '');

    const amtNum = Number(amount);
    let allowedInstallments;
    if (amtNum <= 10000) allowedInstallments = [1];
    else if (amtNum <= 18000) allowedInstallments = [1, 2, 3];
    else allowedInstallments = [1, 2, 3, 4, 5, 6];

    const callbackBase = 'https://www.tamyogastudio.com'; 
    const okUrl   = `${callbackBase}/_functions/akbankCallback?wixTransactionId=${encodeURIComponent(wixTxnRaw)}${ruQS}`; 
    const failUrl = `${callbackBase}/_functions/akbankCallback?wixTransactionId=${encodeURIComponent(wixTxnRaw)}${ruQS}`; 

    const rawInstall = request.query.installCount;
    let installCount = rawInstall ? Number(rawInstall) || 1 : null;
    if (installCount != null && !allowedInstallments.includes(Number(installCount))) {
        installCount = 1;
    }

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
            <h1 id="akb-title-selection">Ödeme Bilgileri</h1>
            <div class="row" id="akb-row-amount"><div class="label">Tutar:</div><div class="amount" id="akb-amount">${amount} TL</div></div>
            <form id="akb-form-select" method="GET" action="/_functions/payRedirect" target="_self" aria-label="Taksit seçim formu">
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
        return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: htmlPage({ title: 'Ödeme - Taksit Seçimi', bodyInner: selectionHtml }) });
    }

    const fields = {
        paymentModel: '3D_PAY_HOSTING',
        txnCode: '3000',
        merchantSafeId,
        terminalSafeId,
        orderId,
        lang: 'TR',
        amount,
        ccbRewardAmount: '0.00',
        pcbRewardAmount: '0.00',
        xcbRewardAmount: '0.00',
        currencyCode,
        installCount: installCount,
        okUrl,
        failUrl,
        emailAddress: '',
        mobilePhone: '',
        homePhone: '',
        workPhone: '',
        randomNumber: randomHex128(),
        requestDateTime: nowIsoMs(),
        b2bIdentityNumber: '',
        merchantData: '',
        merchantBranchNo: '',
        mobileEci: '',
        walletProgramData: '',
        mobileAssignedId: '',
        mobileDeviceType: ''
    };
    const hash = buildRequestHash(fields, secretKey);
    const formFields = { ...fields, hash };
    const inputs = Object.entries(formFields)
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v ?? '').replace(/"/g, '&quot;')}">`)
        .join('\n');
    const monthly = (Number(amount) / Number(installCount)).toFixed(2);
    const confirmHtml = `
      <div class="card" id="akb-card-confirm" role="main" aria-label="Taksit Onay">
        <h1 id="akb-title-confirm">Taksit Onayı</h1>
        <div class="row" id="akb-row-amount-confirm"><div class="label">Tutar:</div><div class="amount" id="akb-amount-confirm">${amount} TL</div></div>
        <div class="row" id="akb-row-install-confirm"><div class="label">Seçilen Taksit:</div><div id="akb-install-chosen">${installCount} ${installCount > 1 ? 'taksit' : 'Peşin'}</div></div>
        <div class="row" id="akb-row-monthly"><div class="label">Her taksit tutarı:</div><div id="akb-monthly">${monthly} TL</div></div>
        <p class="note" id="akb-note">Onay sonrası bankaya yönlendirileceksiniz.</p>
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
    return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: htmlPage({ title: 'Taksit Onayı', bodyInner: confirmHtml }) });
  } catch (e) {
    console.error('get_payRedirect fatal (Akbank VPG)', e);
    return badRequest({ headers: { 'Content-Type': 'text/plain' }, body: String(e) });
  }
}

// =================================================================
// GARANTI REQUEST HANDLER
// =================================================================
export async function get_garantiRedirect(request) {
  try {
    const { wixTxn: wixTxnRaw, amountMinor, currency } = request.query;
    console.log('get_garantiRedirect in', { wixTxnRaw, amountMinor, currency });

    if (!wixTxnRaw || !amountMinor || !(Number(amountMinor) > 0)) {
        return badRequest({ headers: { 'Content-Type': 'text/plain' }, body: 'missing or invalid params' });
    }
    
    const customerIp = request.ip;
    console.log(`INFO: Musteri IP adresi alindi: ${customerIp}`);

    const callbackBase = await getSecret('GARANTI_CALLBACK_BASE_URL'); 
    if (!callbackBase) {
        console.error('get_garantiRedirect: KRİTİK HATA! GARANTI_CALLBACK_BASE_URL secret eksik!');
        const errHtml = `
            <div class="card" id="akb-card-alert" role="alert" aria-live="assertive">
              <h1 id="akb-title-alert">Ayar Hatası (Garanti)</h1>
              <p class="note">Garanti ile bağlantı kurulamadı. Lütfen 'GARANTI_CALLBACK_BASE_URL' secret değerini kontrol edin.</p>
              <div class="actions" id="akb-actions-alert"><a class="btn" href="/" id="akb-alert-home">Ana sayfa</a></div>
            </div>`;
        return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: htmlPage({ title: 'Ayar Hatası', bodyInner: errHtml }) });
    }
    
    console.log(`INFO: garantiCallbackBase resolved successfully to: ${callbackBase}`);

    // Wix Return URLs
    const successUrl = request.query.successUrl ? String(request.query.successUrl) : '';
    const errorUrl   = request.query.errorUrl   ? String(request.query.errorUrl)   : '';
    const cancelUrl  = request.query.cancelUrl  ? String(request.query.cancelUrl)  : '';
    const pendingUrl = request.query.pendingUrl ? String(request.query.pendingUrl) : '';
    
    // Construct query string for our own callback
    const ruQS =
        (successUrl ? `&successUrl=${encodeURIComponent(successUrl)}` : '') +
        (errorUrl   ? `&errorUrl=${encodeURIComponent(errorUrl)}`     : '') +
        (cancelUrl  ? `&cancelUrl=${encodeURIComponent(cancelUrl)}`   : '') +
        (pendingUrl ? `&pendingUrl=${encodeURIComponent(pendingUrl)}` : '');

    const orderId = (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 28).toUpperCase();
    
    // Our Internal Callbacks (Points back to http-functions.js)
    const okUrl = `${String(callbackBase).replace(/\/+$/, '')}/_functions/garantiCallback?wixTransactionId=${encodeURIComponent(wixTxnRaw)}${ruQS}`;
    const failUrl = `${String(callbackBase).replace(/\/+$/, '')}/_functions/garantiCallback?wixTransactionId=${encodeURIComponent(wixTxnRaw)}${ruQS}`;

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
        okUrl: okUrl,     
        failUrl: failUrl,   
        customerIp: customerIp,
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
// AKBANK CALLBACK HANDLER
// =================================================================
export async function post_akbankCallback(request) {
  try {
    let post = {};
    try {
        const raw = await request.body.text();
        post = Object.fromEntries(new URLSearchParams(raw || ''));
    } catch (e) {
        post = {};
    }
    if (!Object.keys(post).length) {
        try { post = Object.fromEntries(new URLSearchParams(request.url.split('?')[1] || '')); } catch (e) {}
    }

    console.log('post_akbankCallback received', post);

    const wixTransactionId = request.query['wixTransactionId'] || post.orderId || '';
    const orderId = post.orderId || '';
    const amount = post.amount || '';

    const successUrl = request.query.successUrl ? String(request.query.successUrl) : '';
    const errorUrl   = request.query.errorUrl   ? String(request.query.errorUrl)   : '';
    const cancelUrl  = request.query.cancelUrl  ? String(request.query.cancelUrl)  : '';
    const pendingUrl = request.query.pendingUrl ? String(request.query.pendingUrl) : '';

    let hashOk = false;
    try { hashOk = await verifyResponseHash(post); } catch (e) { hashOk = false; }
    console.log('post_akbankCallback hashOk:', hashOk);
    if (!hashOk) console.warn('AKBANK CALLBACK: Hash doğrulaması BAŞARISIZ.');

    const code = String(post.responseCode || '').toUpperCase();
    const host = String(post.hostResponseCode || '');
    const responseMessage = String(post.responseMessage || '');

    const isCancel  = (code === 'VPS-3008') || /iptal|cancel/i.test(responseMessage);
    const isSuccess = (code === 'VPS-0000' && host === '00');
    const isPending = /pend/i.test(responseMessage) || /^VPS-10/i.test(code) || String(post.txnStatus || '').toUpperCase() === 'PENDING';

    if (isSuccess && hashOk) { 
        try {
            if (wixTransactionId) {
                await wixPaymentProviderBackend.submitEvent({ event: { transaction: { wixTransactionId, pluginTransactionId: post.rrn || post.authCode || 'AKBANK_VPG' } } });
            }
        } catch (e) { console.warn('submitEvent error (ignored):', e); }

        const target = successUrl || `/odeme/basarili?wixTxn=${encodeURIComponent(wixTransactionId)}&orderId=${encodeURIComponent(orderId)}&amount=${encodeURIComponent(amount)}`;
        if (successUrl) return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: redirectOnlyHtmlTop(target) });
        return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: autoCloseHtml({ redirect: target }) });
    }

    if (isCancel) {
        const target = cancelUrl || `/odeme/iptal?orderId=${encodeURIComponent(orderId)}`;
        if (cancelUrl) return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: redirectOnlyHtmlTop(target) });
        return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: autoCloseHtml({ redirect: target }) });
    }

    if (isPending) {
        const target = pendingUrl || `/odeme/beklemede?orderId=${encodeURIComponent(orderId)}`;
        if (pendingUrl) return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: redirectOnlyHtmlTop(target) });
        return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: autoCloseHtml({ redirect: target }) });
    }

    const reason = mapHostMsg(host) || (responseMessage || (hashOk ? 'Ödeme başarısız.' : 'Hash Hatası.'));
    const fallbackErr = `/odeme/basarisiz?host=${encodeURIComponent(host)}&msg=${encodeURIComponent(reason)}&orderId=${encodeURIComponent(orderId)}`;
    const target = errorUrl || fallbackErr;
    if (errorUrl) return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: redirectOnlyHtmlTop(target) });
    return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: autoCloseHtml({ redirect: target }) });

  } catch (err) {
    console.error('post_akbankCallback fatal', err);
    const target = '/';
    return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: autoCloseHtml({ redirect: target }) });
  }
}

export async function get_akbankCallback(request) {
  return post_akbankCallback(request);
}

// =================================================================
// GARANTI CALLBACK HANDLER (WITH KEY NORMALIZATION FIX)
// =================================================================
export async function post_garantiCallback(request) {
    try {
        // 1. Parse Body
        let post = {};
        try {
            const raw = await request.body.text();
            post = Object.fromEntries(new URLSearchParams(raw || ''));
        } catch (e) {
            console.error('Garanti Callback Parse Error:', e);
            post = {};
        }

        // ====================================================
        // 2. KEY NORMALIZATION (FIX)
        // Garanti sends 'HashParams' or 'hashparams' unpredictably.
        // We lowercase all keys to ensure our wrapper can find the data.
        // ====================================================
        const normalizedPost = {};
        Object.keys(post).forEach(key => {
            normalizedPost[key.toLowerCase()] = post[key];
        });

        console.log('post_garantiCallback (Normalized) received:', normalizedPost);

        // Retrieve IDs from normalized data
        const wixTransactionId = request.query['wixTransactionId'] || normalizedPost.oid || '';
        const orderId = normalizedPost.oid || '';
        const amount = normalizedPost.amount || ''; 

        // Wix Return URLs from Query Params
        const successUrl = request.query.successUrl ? String(request.query.successUrl) : '';
        const errorUrl   = request.query.errorUrl   ? String(request.query.errorUrl)   : '';

        // 3. Verify Hash (Using normalized object)
        let hashOk = false;
        try {
            // verifyGarantiHash now checks .hashparams (lowercase) successfully
            hashOk = await verifyGarantiHash(normalizedPost);
        } catch (e) {
            console.error('post_garantiCallback verifyGarantiHash critical error:', e);
            hashOk = false;
        }
        
        console.log(`Hash Verification Result: ${hashOk}. (Order ID: ${orderId})`);
        if (!hashOk) console.warn('GARANTI CALLBACK: Hash mismatch or missing params.');

        // 4. Check Approval
        const isApproved = isGarantiApproved(normalizedPost);
        const hostCode = String(normalizedPost.procreturncode || '');
        const mdStatus = String(normalizedPost.mdstatus || '');
        const bankErrorMsg = String(normalizedPost.mderrormessage || normalizedPost.errmsg || 'İşlem banka tarafından reddedildi.');

        console.log(`Transaction Approval: ${isApproved} (MD: ${mdStatus}, Code: ${hostCode})`);

        // ----------------------------------------------------
        // A. SUCCESS FLOW
        // ----------------------------------------------------
        if (isApproved && hashOk) {
            try {
                if (wixTransactionId) {
                    // Submit Event to Wix
                    await wixPaymentProviderBackend.submitEvent({ event: { transaction: { wixTransactionId, pluginTransactionId: normalizedPost.authcode || normalizedPost.retref || 'GARANTI_OOS' } } });
                }
            } catch (e) { console.warn('submitEvent error (ignored):', e); }

            const target = successUrl || `/odeme/basarili?wixTxn=${encodeURIComponent(wixTransactionId)}&orderId=${encodeURIComponent(orderId)}&amount=${encodeURIComponent(amount)}`;
            
            if (successUrl) {
                 return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: redirectOnlyHtmlTop(target) });
            }
            return ok({ headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: autoCloseHtml({ redirect: target }) });
        }
        
        // ----------------------------------------------------
        // B. FAILURE FLOW
        // ----------------------------------------------------
        const reason = `Hata Kodu: ${hostCode} / MD: ${mdStatus}. ${bankErrorMsg}` + (hashOk ? '' : ' (Hash Hatası!)');
        console.warn(`Failed Transaction (oid: ${orderId}). Reason: ${reason}`);

        const fallbackErr = `/odeme/basarisiz?host=${encodeURIComponent(hostCode)}&msg=${encodeURIComponent(reason)}&orderId=${encodeURIComponent(orderId)}`;
        const target = errorUrl || fallbackErr;
        
        // Show descriptive error page if errorUrl exists (Wix flow)
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

export async function get_garantiCallback(request) {
  return post_garantiCallback(request);
}