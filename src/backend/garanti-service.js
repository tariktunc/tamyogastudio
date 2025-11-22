// backend/garanti-service.js
import { ok, badRequest } from 'wix-http-functions';
import wixPaymentProviderBackend from 'wix-payment-provider-backend';
import {
  buildPayHostingForm as buildGarantiForm,
  verifyCallbackHash as verifyGarantiHash,
  isApproved as isGarantiApproved
} from 'backend/garanti-vpg-wrapper';

// Callback base URL'i
const GARANTI_CALLBACK_BASE = 'https://www.tamyogastudio.com';

function htmlPage({ title = 'Ödeme', bodyInner = '' } = {}) {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${String(title)}</title>
<link rel="stylesheet" href="/_functions/paycss">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .card { border-radius: 8px; padding: 2rem; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
  .note { color: #666; font-size: 0.95rem; margin: 1rem 0; }
  .actions { margin-top: 2rem; display: flex; gap: 1rem; }
  .btn { padding: 0.75rem 1.5rem; border: none; border-radius: 4px; cursor: pointer; text-decoration: none; display: inline-block; }
  .btn { background: #f0f0f0; color: #333; }
  .btn-primary { background: #0066cc; color: white; }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
</head>
<body id="akb-body"><div class="wrap" id="akb-wrap">${bodyInner}</div></body>
</html>`;
}

function redirectOnlyHtmlTop(target) {
  const safe = String(target || '/');
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Yönlendiriliyor...</title>
</head>
<body>
<script>
try{ window.top.location.replace(${JSON.stringify(safe)}); }
catch(e){ location.href=${JSON.stringify(safe)}; }
</script>
<noscript><meta http-equiv="refresh" content="0;url=${safe}"></noscript>
</body>
</html>`;
}

function autoCloseHtml({ redirect = '/' } = {}) {
  const safe = String(redirect || '/');
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pencereyi Kapatın</title>
</head>
<body>
<p>Ödeme işlemi tamamlanmıştır. Pencereyi kapatabilirsiniz...</p>
<script>
try{
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage({type:'GARANTI_PAYMENT_DONE'}, '*');
  }
}catch(e){}
try{
  if (window.opener && !window.opener.closed) {
    window.opener.location.reload();
  }
}catch(e){}
setTimeout(function(){ try{ window.close(); }catch(e){} }, 1000);
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
    
    console.log('\n' + '='.repeat(70));
    console.log('GARANTI REDIRECT REQUEST - PRODUCTION');
    console.log('='.repeat(70));
    console.log('Wix Transaction ID:', wixTxnRaw);
    console.log('Amount (kuruş):', amountMinor);
    console.log('Currency:', currency);
    console.log('Customer IP:', request.ip);

    // Parametreleri valide et
    if (!wixTxnRaw || !amountMinor || !(Number(amountMinor) > 0)) {
      console.error('❌ Hatalı parametreler');
      return badRequest({
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: 'Eksik veya hatalı parametreler'
      });
    }

    const customerIp = request.ip;
    const callbackBase = GARANTI_CALLBACK_BASE;

    // Order ID oluştur (rastgele, max 28 karakter)
    const orderId = (Date.now().toString(36) + Math.random().toString(36).slice(2))
      .slice(0, 28)
      .toUpperCase();

    // Callback URL'leri oluştur
    const okUrl = `${String(callbackBase).replace(/\/+$/, '')}/_functions/garantiCallback?wixTransactionId=${encodeURIComponent(wixTxnRaw)}&type=success`;
    const failUrl = `${String(callbackBase).replace(/\/+$/, '')}/_functions/garantiCallback?wixTransactionId=${encodeURIComponent(wixTxnRaw)}&type=fail`;

    console.log('Generated Order ID:', orderId);
    console.log('Success URL:', okUrl);
    console.log('Fail URL:', failUrl);

    // Tutar TL'ye dönüştür (gösterim için)
    const amountTL = (parseInt(String(amountMinor), 10) / 100).toFixed(2);

    console.log('Tutar (TL):', amountTL);
    console.log('='.repeat(70));

    // Garanti formunu üret - ÖNEMLİ: installments BOŞ OLMALI!
    const { actionUrl, formFields } = await buildGarantiForm({
      orderId,
      amountMinor: String(amountMinor),
      currency,
      okUrl,
      failUrl,
      customerIp,
      installments: '' // PEŞİN ÖDEME İÇİN MUTLAKA BOŞ STRING!
    });

    // Form input'larını HTML'e dönüştür
    const inputs = Object.entries(formFields)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v ?? '').replace(/"/g, '&quot;')}">`)
      .join('\n');

    // Onay sayfası HTML'i
    const confirmHtml = `
      <div class="card" id="akb-card-confirm" role="main">
        <h1>Ödeme Onayı (Garanti BBVA)</h1>
        <div style="margin: 2rem 0;">
          <div style="padding: 1rem; background: #f5f5f5; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; margin: 0.5rem 0;">
              <span>Tutar:</span>
              <strong style="font-size: 1.2em;">${amountTL} TL</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin: 0.5rem 0;">
              <span>Ödeme Tipi:</span>
              <span>Peşin Ödeme</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin: 0.5rem 0;">
              <span>Sipariş No:</span>
              <span style="font-family: monospace; font-size: 0.9em;">${orderId}</span>
            </div>
          </div>
        </div>

        <p class="note">
          Aşağıdaki butona tıkladığınızda Garanti BBVA güvenli ödeme sayfasına yönlendirileceksiniz. 
          Orada 3D Secure ile güvenli bir şekilde ödemenizi yapabilirsiniz.
        </p>
        
        <form id="akb-form" method="POST" action="${actionUrl}" target="_self">
          ${inputs}
          <div class="actions">
            <a href="/" class="btn">İptal</a>
            <button type="submit" class="btn btn-primary" id="akb-submit">Ödemeye Geç</button>
          </div>
        </form>
      </div>

      <script>
      (function(){
        var f = document.getElementById('akb-form');
        var btn = document.getElementById('akb-submit');
        if(!f || !btn) return;
        
        var sent = false;
        f.addEventListener('submit', function(e){
          if(sent) { e.preventDefault(); return; }
          sent = true;
          btn.disabled = true;
          btn.textContent = 'Yönlendiriliyor...';
        }, false);
      })();
      </script>
    `;

    console.log('✅ Onay sayfası oluşturuldu\n');

    return ok({
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: htmlPage({ title: 'Ödeme Onayı (Garanti)', bodyInner: confirmHtml })
    });

  } catch (e) {
    console.error('❌ Redirect Hatası:', e);
    return badRequest({
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: 'Hata: ' + (e?.message || String(e))
    });
  }
}

// =====================================================================
// CALLBACK - Garanti'den geri dönüş
// =====================================================================
export async function callback(request) {
  try {
    console.log('\n' + '='.repeat(70));
    console.log('GARANTI CALLBACK HANDLER - PRODUCTION');
    console.log('='.repeat(70));
    console.log('Method:', request.method);
    console.log('Query Params:', JSON.stringify(request.query));

    // POST verisini parse et
    let post = {};
    try {
      const raw = await request.body.text();
      console.log('POST Body alındı, parsing...');
      post = Object.fromEntries(new URLSearchParams(raw || ''));
    } catch (e) {
      console.error('⚠️ POST Parse Hatası:', e);
      post = {};
    }

    // Büyük/küçük harf sensitivitesini kaldır
    const normalizedPost = {};
    Object.keys(post).forEach(key => {
      normalizedPost[key.toLowerCase()] = post[key];
    });

    console.log('\nDönen POST Alanları:', Object.keys(normalizedPost).sort().join(', '));

    // Wix Transaction ID'yi al
    const wixTransactionId =
      (request.query && request.query.wixTransactionId) ||
      normalizedPost.oid ||
      normalizedPost.orderid ||
      '';

    const orderId = normalizedPost.oid || normalizedPost.orderid || '';
    const amount = normalizedPost.txnamount || normalizedPost.amount || '';

    console.log('\nİşlem Bilgileri:');
    console.log('  Wix Transaction ID:', wixTransactionId);
    console.log('  Order ID:', orderId);
    console.log('  Amount:', amount);

    // Hash doğrulaması yap
    let hashOk = false;
    try {
      hashOk = await verifyGarantiHash(normalizedPost);
    } catch (e) {
      console.error('⚠️ Hash doğrulama hatası:', e);
      hashOk = false;
    }

    // İşlem onayını kontrol et
    const approved = isGarantiApproved(normalizedPost);
    const mdStatus = String(normalizedPost.mdstatus || '');
    const procReturnCode = String(normalizedPost.procreturncode || '');
    const errorMsg = String(
      normalizedPost.mderrormessage ||
      normalizedPost.errmsg ||
      'İşlem banka tarafından reddedildi.'
    );

    console.log('\n[Sonuç]');
    console.log('  Hash Doğru:', hashOk ? '✅' : '❌');
    console.log('  MD Status:', mdStatus);
    console.log('  Proc Return Code:', procReturnCode);
    console.log('  Hata Mesajı:', errorMsg);

    // Başarılı işlem
    if (approved && hashOk) {
      console.log('\n✅ İŞLEM BAŞARILI - Wix\'e bildiriliyor...');
      
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
          console.log('✅ Wix event gönderildi');
        }
      } catch (e) {
        console.warn('⚠️ Wix event hatası (göz ardı):', e);
      }

      const target = `/odeme/basarili?wixTxn=${encodeURIComponent(wixTransactionId)}&orderId=${encodeURIComponent(orderId)}&amount=${encodeURIComponent(amount)}`;
      console.log('Yönlendirme:', target);
      console.log('='.repeat(70) + '\n');

      return ok({
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: autoCloseHtml({ redirect: target })
      });
    }

    // Başarısız işlem
    console.error('\n❌ İŞLEM BAŞARISIZ');
    const reason = `Hata: ${procReturnCode} / MD: ${mdStatus} - ${errorMsg}`;
    const target = `/odeme/basarisiz?host=${encodeURIComponent(procReturnCode)}&msg=${encodeURIComponent(reason)}&orderId=${encodeURIComponent(orderId)}`;

    console.log('Yönlendirme:', target);
    console.log('='.repeat(70) + '\n');

    const errHtml = `
      <div class="card" id="akb-card-alert" role="alert">
        <h1>Ödeme Başarısız</h1>
        <p class="note">Banka Yanıtı: <strong>${errorMsg}</strong></p>
        <p class="note" style="font-size: 0.85em; color: #999;">
          Kod: ${procReturnCode} | MD: ${mdStatus}
        </p>
        <div class="actions">
          <a class="btn btn-primary" href="${target}">Devam Et</a>
        </div>
      </div>`;

    return ok({
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: htmlPage({ title: 'Ödeme Başarısız', bodyInner: errHtml })
    });

  } catch (err) {
    console.error('❌ CALLBACK FATAL ERROR:', err);
    return ok({
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: autoCloseHtml({ redirect: '/' })
    });
  }
}