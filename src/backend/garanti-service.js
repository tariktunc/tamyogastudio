// backend/garanti-service.js
import { ok, badRequest } from 'wix-http-functions';
import wixPaymentProviderBackend from 'wix-payment-provider-backend';
import {
  buildPayHostingForm as buildGarantiForm,
  verifyCallbackHash as verifyGarantiHash,
  isApproved as isGarantiApproved
} from 'backend/garanti-vpg-wrapper';

// Callback Base URL
const GARANTI_CALLBACK_BASE = 'https://www.tamyogastudio.com';

// HTML Şablonu
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

// Başarı durumunda üst pencereyi yönlendiren HTML
function redirectOnlyHtmlTop(target) {
  const safe = String(target || '/');
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Yönlendiriliyor...</title>
<link rel="stylesheet" href="/_functions/paycss">
</head>
<body id="akb-body"><div class="wrap" id="akb-wrap">
  <div class="card" id="akb-card-alert" role="alert" aria-live="polite">
    <h2 id="akb-close-title">Yönlendiriliyor...</h2>
  </div>
</div>
<script>
try{
  window.top.location.replace(${JSON.stringify(safe)});
}catch(e){
  location.href=${JSON.stringify(safe)};
}
</script>
<noscript><meta http-equiv="refresh" content="0;url=${safe}"></noscript>
</body>
</html>`;
}

// Popup kapatan HTML
function autoCloseHtml({ redirect = '/' } = {}) {
  const safe = String(redirect || '/');
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PENCEREYİ KAPATIN</title>
<link rel="stylesheet" href="/_functions/paycss">
</head>
<body id="akb-body"><div class="wrap" id="akb-wrap">
  <div class="card" id="akb-card-alert" role="alert" aria-live="polite">
    <h2 id="akb-close-title">PENCEREYİ KAPATIN</h2>
  </div>
</div>
<script>
try{
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({type:'GARANTI_PAYMENT_DONE'}, '*');
    }
  } catch(e){}
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.location.reload();
    }
  } catch(e){}
  setTimeout(function(){
    try{ window.close(); }catch(e){}
  }, 800);
}catch(e){}
</script>
<noscript><meta http-equiv="refresh" content="0;url=${safe}"></noscript>
</body>
</html>`;
}

// =====================================================================
// REDIRECT - Garanti ödeme sayfasına yönlendirme
// =====================================================================
export async function redirect(request) {
  try {
    const { wixTxn: wixTxnRaw, amountMinor, currency } = request.query || {};
    console.log('get_garantiRedirect in', { wixTxnRaw, amountMinor, currency });

    if (!wixTxnRaw || !amountMinor || !(Number(amountMinor) > 0)) {
      return badRequest({
        headers: { 'Content-Type': 'text/plain' },
        body: 'missing or invalid params'
      });
    }

    const customerIp = request.ip;
    const callbackBase = GARANTI_CALLBACK_BASE;

    // Wix return url parametreleri (sadece taksit seçim ekranında hidden input olarak kullanıyoruz)
    const successUrl = request.query.successUrl ? String(request.query.successUrl) : '';
    const errorUrl   = request.query.errorUrl   ? String(request.query.errorUrl)   : '';

    const orderId = (Date.now().toString(36) + Math.random().toString(36).slice(2))
      .slice(0, 28)
      .toUpperCase();

    // Callback URL'leri
    const okUrl = `${String(callbackBase).replace(/\/+$/, '')}/_functions/garantiCallback?wixTransactionId=${encodeURIComponent(wixTxnRaw)}`;
    const failUrl = `${String(callbackBase).replace(/\/+$/, '')}/_functions/garantiCallback?wixTransactionId=${encodeURIComponent(wixTxnRaw)}`;

    const amount = (parseInt(String(amountMinor), 10) / 100).toFixed(2);

    // *** DEĞİŞİKLİK: Taksit Seçimi İptal Edildi ***
    // Her zaman "1" (Peşin) olarak gönderiyoruz.
    const installStr = ''; 

    // Garanti formunu üret (Wrapper'daki yeni OOS yapısını kullanır)
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

    // Doğrudan Ödeme Onay Ekranı (Taksit seçimi yok)
    const confirmHtml = `
      <div class="card" id="akb-card-confirm" role="main" aria-label="Ödeme Onay">
        <h1 id="akb-title-confirm">Ödeme Onayı (Garanti BBVA)</h1>
        <div class="row" id="akb-row-amount-confirm"><div class="label">Tutar:</div><div class="amount" id="akb-amount-confirm">${amount} TL</div></div>
        <div class="row" id="akb-row-install-confirm"><div class="label">Ödeme Tipi:</div><div id="akb-install-chosen">Peşin Ödeme</div></div>
        <p class="note" id="akb-note">Aşağıdaki butona tıkladığınızda Garanti BBVA güvenli ödeme sayfasına yönlendirileceksiniz.</p>
        
        <form id="akb-form" method="POST" action="${actionUrl}" target="_self" aria-label="Bankaya yönlendirme formu">
          ${inputs}
          <div class="actions" id="akb-actions-confirm">
            <a href="/" class="btn" id="akb-confirm-cancel" target="_self" rel="noopener" aria-label="İptal">İptal</a>
            <button id="akb-submit" type="submit" class="btn btn-primary" aria-label="Ödemeye Geç">Ödemeye Geç</button>
          </div>
        </form>
      </div>
      <script>
      (function(){
        var f=document.getElementById('akb-form');
        var btn=document.getElementById('akb-submit');
        var sent=false;
        if(!f||!btn)return;
        
        f.addEventListener('submit',function(e){
          if(sent){e.preventDefault();return;}
          sent=true;
          try{
            btn.setAttribute('disabled','disabled');
            btn.textContent='Yönlendiriliyor…';
          }catch(e){}
        },false);
      })();
      </script>
    `;

    return ok({
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: htmlPage({ title: 'Ödeme Onayı (Garanti)', bodyInner: confirmHtml })
    });
  } catch (e) {
    console.error('Garanti redirect ERROR:', e);
    return badRequest({
      headers: { 'Content-Type': 'text/plain' },
      body: String(e && e.message ? e.message : e)
    });
  }
}

// =====================================================================
// CALLBACK - Garanti dönüşü
// =====================================================================
export async function callback(request) {
  try {
    let post = {};
    try {
      const raw = await request.body.text();
      post = Object.fromEntries(new URLSearchParams(raw || ''));
    } catch (e) {
      console.error('Garanti Callback Parse Error:', e);
      post = {};
    }

    const normalizedPost = {};
    Object.keys(post).forEach(key => {
      normalizedPost[key.toLowerCase()] = post[key];
    });

    console.log('post_garantiCallback received:', normalizedPost);

    const wixTransactionId =
      (request.query && request.query.wixTransactionId) ||
      normalizedPost.oid ||
      normalizedPost.orderid ||
      '';

    const orderId = normalizedPost.oid || normalizedPost.orderid || '';
    const amount = normalizedPost.txnamount || normalizedPost.amount || '';

    const successUrl = request.query && request.query.successUrl ? String(request.query.successUrl) : '';
    const errorUrl   = request.query && request.query.errorUrl   ? String(request.query.errorUrl)   : '';

    let hashOk = false;
    try {
      hashOk = await verifyGarantiHash(normalizedPost);
    } catch (e) {
      console.error('post_garantiCallback verifyGarantiHash error:', e);
      hashOk = false;
    }

    if (!hashOk) console.warn('GARANTI CALLBACK: Hash mismatch or missing params.');

    const approved = isGarantiApproved(normalizedPost);
    const hostCode = String(normalizedPost.procreturncode || '');
    const mdStatus = String(normalizedPost.mdstatus || '');
    const bankErrorMsg =
      String(
        normalizedPost.mderrormessage ||
        normalizedPost.errmsg ||
        'İşlem banka tarafından reddedildi.'
      );

    console.log(`Transaction Approval: ${approved} (MD: ${mdStatus}, Code: ${hostCode})`);

    if (approved && hashOk) {
      try {
        if (wixTransactionId) {
          await wixPaymentProviderBackend.submitEvent({
            event: {
              transaction: {
                wixTransactionId,
                pluginTransactionId:
                  normalizedPost.authcode ||
                  normalizedPost.retref ||
                  'GARANTI_OOS'
              }
            }
          });
        }
      } catch (e) {
        console.warn('submitEvent error (ignored):', e);
      }

      const target =
        successUrl ||
        `/odeme/basarili?wixTxn=${encodeURIComponent(wixTransactionId)}&orderId=${encodeURIComponent(
          orderId
        )}&amount=${encodeURIComponent(amount)}`;

      if (successUrl) {
        return ok({
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: redirectOnlyHtmlTop(target)
        });
      }
      return ok({
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: autoCloseHtml({ redirect: target })
      });
    }

    const reason = `Hata Kodu: ${hostCode} / MD: ${mdStatus}. ${bankErrorMsg}` + (hashOk ? '' : ' (Hash Hatası!)');
    console.warn(`Failed Transaction (oid: ${orderId}). Reason: ${reason}`);

    const fallbackErr = `/odeme/basarisiz?host=${encodeURIComponent(
      hostCode
    )}&msg=${encodeURIComponent(reason)}&orderId=${encodeURIComponent(orderId)}`;
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
      return ok({
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: htmlPage({ title: 'Ödeme Başarısız', bodyInner: errHtml })
      });
    }

    return ok({
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: autoCloseHtml({ redirect: target })
    });
  } catch (err) {
    console.error('post_garantiCallback fatal', err);
    const target = '/';
    return ok({
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: autoCloseHtml({ redirect: target })
    });
  }
}