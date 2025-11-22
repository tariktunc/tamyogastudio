import { ok, badRequest } from 'wix-http-functions';
import {
  buildPayHostingForm as buildGarantiForm,
  verifyCallbackHash as verifyGarantiHash,
  isApproved as isGarantiApproved
} from 'backend/garanti-vpg-wrapper';

const GARANTI_CALLBACK_BASE = 'https://www.tamyogastudio.com';

// ==================== YARDIMCI FONKSİYONLAR ====================

// HTML Sayfası Oluşturucu
function htmlPage({ title = 'Ödeme', bodyInner = '' } = {}) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:sans-serif;padding:20px;background:#f4f4f5;color:#333}.wrap{max-width:600px;margin:0 auto;background:#fff;padding:30px;border-radius:8px;box-shadow:0 2px 5px rgba(0,0,0,0.1)}table{width:100%;border-collapse:collapse;margin:20px 0}th,td{text-align:left;padding:10px;border-bottom:1px solid #eee}th{color:#666}.btn{display:block;width:100%;padding:15px;background:#22c55e;color:#fff;text-align:center;text-decoration:none;font-weight:bold;border-radius:5px;border:none;cursor:pointer;font-size:16px}.debug{margin-top:30px;padding:15px;background:#f0f0f0;border-radius:5px;font-size:12px;overflow-x:auto}</style></head><body><div class="wrap">${bodyInner}</div></body></html>`;
}

// Callback Parse Edici (ISO-8859-9 Sorununu Çözer)
async function parseBody(request) {
  try {
    // Body'yi Buffer olarak al
    const buffer = await request.body.arrayBuffer();
    // Latin1 (ISO-8859-1) olarak oku, Türkçe karakterler bozulabilir ama Hash bozulmaz.
    // Banka genellikle veriyi form-urlencoded gönderir.
    const text = Buffer.from(buffer).toString('binary'); // 'binary' veya 'latin1' hash için en güvenlisidir.
    
    const params = new URLSearchParams(text);
    const obj = {};
    for (const [key, value] of params.entries()) {
      obj[key] = value;
    }
    return { raw: text, obj };
  } catch (e) {
    console.error('Parse Error:', e);
    return { raw: '', obj: {} };
  }
}

// ==================== ENDPOINTS ====================

// 1. YÖNLENDİRME (Redirect)
export async function redirect(request) {
  try {
    const { wixTxn: wixTxnRaw, amountMinor, currency } = request.query || {};
    
    if (!wixTxnRaw || !amountMinor) return badRequest({ body: 'Eksik Parametre' });

    const orderId = (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 20).toUpperCase();
    
    // URL'leri ayırıyoruz: success ve error
    const okUrl = `${GARANTI_CALLBACK_BASE}/_functions/garantiCallback?res=ok&wixTxn=${encodeURIComponent(wixTxnRaw)}`;
    const failUrl = `${GARANTI_CALLBACK_BASE}/_functions/garantiCallback?res=fail&wixTxn=${encodeURIComponent(wixTxnRaw)}`;

    // Wrapper çağır
    const { actionUrl, formFields, debugString } = await buildGarantiForm({
      orderId,
      amountMinor,
      currency,
      okUrl,
      failUrl,
      customerIp: request.ip || '127.0.0.1',
      installments: '1' // Test ortamı için sabit 1
    });

    // Form HTML
    const inputs = Object.entries(formFields)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`)
      .join('\n');

    const html = `
      <h1>Ödeme Onayı</h1>
      <p>Garanti BBVA Test Ortamına Yönlendiriliyorsunuz.</p>
      <form action="${actionUrl}" method="POST">
        ${inputs}
        <button type="submit" class="btn">Ödemeyi Tamamla</button>
      </form>
      <div class="debug">
        <strong>DEBUG (Hash String):</strong><br>${debugString}<br><br>
        <strong>Giden Form:</strong><br>${JSON.stringify(formFields, null, 2)}
      </div>
    `;

    return ok({
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: htmlPage({ title: 'Ödeme Onay', bodyInner: html })
    });

  } catch (e) {
    return badRequest({ body: e.message });
  }
}

// 2. DÖNÜŞ (Callback)
export async function callback(request) {
  try {
    // Body'yi güvenli parse et
    const { raw, obj: post } = await parseBody(request);
    
    console.log('------------------------------------------------');
    console.log('GARANTI CALLBACK RAW:', raw); // Raw veriyi görelim
    console.log('GARANTI CALLBACK OBJ:', JSON.stringify(post, null, 2)); // Parse edilmiş halini görelim
    console.log('------------------------------------------------');

    // Normalize (Küçük harfe çevir)
    const normalized = {};
    Object.keys(post).forEach(k => normalized[k.toLowerCase()] = post[k]);

    const hashOk = await verifyGarantiHash(normalized);
    const approved = isGarantiApproved(normalized);
    
    // Sonuç Ekranı
    let resultHtml = '';
    if (approved && hashOk) {
        resultHtml = `<h1 style="color:green">Ödeme Başarılı!</h1><p>Siparişiniz alındı.</p>`;
    } else {
        const errCode = normalized.procreturncode || normalized.hostmsg || '??';
        const errMsg = normalized.errmsg || normalized.mderrormessage || 'Bilinmiyor';
        resultHtml = `
            <h1 style="color:red">Ödeme Başarısız</h1>
            <p><strong>Kod:</strong> ${errCode}</p>
            <p><strong>Mesaj:</strong> ${errMsg}</p>
            <p><strong>Hash Durumu:</strong> ${hashOk ? '<span style="color:green">Doğru</span>' : '<span style="color:red">Hatalı</span>'}</p>
        `;
    }

    return ok({
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: htmlPage({ title: 'Sonuç', bodyInner: resultHtml })
    });

  } catch (e) {
    console.error(e);
    return ok({ body: 'Callback Error' });
  }
}