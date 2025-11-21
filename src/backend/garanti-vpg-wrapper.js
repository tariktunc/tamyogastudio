import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- YARDIMCI: String Temizleme ---
function cleanStr(str) {
    return String(str || '').trim();
}

// [1. ADIM] ŞİFRE HASHLEME
function createHashedPassword(password, terminalId) {
    console.warn('[ADIM 5] Şifre Hashleme Başladı...');
    const terminalIdPadded = String(terminalId).trim().padStart(9, '0');
    const plain = password + terminalIdPadded;
    
    // Güvenlik için şifrenin ilk 2 harfi hariç gizliyoruz
    const maskedPass = password.substring(0, 2) + '***';
    console.warn(`[ADIM 5-Detay] Şifre Girdisi: ${maskedPass} + ${terminalIdPadded}`);

    return crypto.createHash('sha1')
        .update(plain, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// [2. ADIM] ANA HASH OLUŞTURMA
function createSecure3DHash({ terminalId, orderId, amount, currency, okUrl, failUrl, txnType, installments, storeKey, hashedPassword }) {
    console.warn('[ADIM 7] Ana Hash Dizisi Oluşturuluyor...');
    
    const plainText = 
        terminalId +
        orderId +
        amount +
        currency +
        okUrl +
        failUrl +
        txnType +
        installments +
        storeKey +
        hashedPassword;

    console.warn('------------------------------------------------');
    console.warn('[ADIM 7-KRİTİK] BANKAYA GİDEN HASH STRING (Bunu Kontrol Et):');
    console.warn(plainText);
    console.warn('------------------------------------------------');

    return crypto.createHash('sha512')
        .update(plainText, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// =========================================================
// FORM OLUŞTURMA
// =========================================================

export async function buildPayHostingForm({
  orderId,
  amountMinor,
  currency = '949',
  okUrl,
  failUrl,
  installments = '',
  txnType = 'sales',
  customerIp,
  email = 'musteri@example.com'
}) {
    console.warn('[ADIM 1] Form Oluşturucu Başlatıldı. Gelen Sipariş ID:', orderId);

    // 1. Secretları Çek
    console.warn('[ADIM 2] Secret Anahtarlar Çağrılıyor...');
    const [rawTerminalId, merchantId, password, rawStoreKey, gatewayUrl] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'),
        getSecret('GARANTI_ENC_KEY'),
        getSecret('GARANTI_CALLBACK_PATH')
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) {
        console.error('[HATA] Secret anahtarlarından biri eksik!');
        throw new Error('Garanti Secrets missing!');
    }
    console.warn('[ADIM 2-OK] Secretlar başarıyla alındı.');

    // 2. Veri Temizliği
    const terminalIdRaw = cleanStr(rawTerminalId);
    const passwordClean = cleanStr(password);
    const storeKeyClean = cleanStr(rawStoreKey);
    
    // 3. Formatlama
    console.warn('[ADIM 3] Veriler Formatlanıyor...');
    const amountNum = Number(amountMinor) / 100;
    const amountClean = amountNum.toFixed(2); 
    console.warn(`[ADIM 3-Detay] Tutar: ${amountMinor} -> ${amountClean}`);

    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);

    // 4. Mantık Kararları (Logic)
    console.warn('[ADIM 4] Taksit ve İşlem Tipi Kararı Veriliyor...');
    
    // Taksit: Peşin ise boş string
    let finalInstallment = '';
    if (installments && installments !== '0' && installments !== '1') {
        finalInstallment = String(installments);
    }
    console.warn(`[ADIM 4-Detay] Gelen Taksit: "${installments}" -> Giden Taksit: "${finalInstallment}"`);

    // İşlem Tipi: sales
    const finalType = txnType || 'sales';
    console.warn(`[ADIM 4-Detay] İşlem Tipi: "${finalType}"`);

    // Zaman Damgası
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 5. Şifre Hash
    const hashedPassword = createHashedPassword(passwordClean, terminalIdRaw);

    // 6. URL Hazırlığı
    console.warn('[ADIM 6] URL Kontrolü...');
    const cleanBase = String(gatewayUrl || 'https://sanalposprovtest.garantibbva.com.tr').replace(/\/+$/, '');
    const actionUrl = cleanBase.includes('gt3dengine') ? cleanBase : `${cleanBase}/servlet/gt3dengine`;
    console.warn(`[ADIM 6-Detay] Hedef URL: ${actionUrl}`);

    // 7. Ana Hash
    const hash = createSecure3DHash({
        terminalId: terminalIdRaw,
        orderId,
        amount: amountClean,
        currency: currencyCode,
        okUrl,
        failUrl,
        txnType: finalType,
        installments: finalInstallment,
        storeKey: storeKeyClean,
        hashedPassword
    });

    console.warn('[ADIM 8] Form Nesnesi Hazırlanıyor...');
    const formFields = {
        mode: 'TEST',
        apiversion: 'v0.01',
        secure3dsecuritylevel: '3D_OOS_FULL',
        terminalprovuserid: 'PROVAUT',
        terminaluserid: 'PROVAUT',
        terminalmerchantid: cleanStr(merchantId),
        terminalid: terminalIdRaw,
        orderid: orderId,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        txnamount: amountClean,
        txncurrencycode: currencyCode,
        txntype: finalType,
        txninstallmentcount: finalInstallment,
        successurl: okUrl,
        errorurl: failUrl,
        txntimestamp: timestamp,
        secure3dhash: hash,
        lang: 'tr'
    };

    console.warn('[ADIM 9] Form Hazır, Frontend tarafına gönderiliyor.');
    return { actionUrl, formFields };
}

// =========================================================
// DÖNÜŞ KONTROLÜ
// =========================================================

export async function verifyCallbackHash(postBody) {
    try {
        console.warn('[CALLBACK] Banka Dönüşü İnceleniyor...');
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const storeKey = cleanStr(rawStoreKey);

        const responseHash = postBody.hash || postBody.HASH || postBody.secure3dhash;
        const hashParams = postBody.hashparams || postBody.hashParams || postBody.HASHPARAMS;

        if (!responseHash || !hashParams) {
            console.warn('[CALLBACK-HATA] HashParams veya Hash eksik. İşlem Reddedilmiş.');
            return false;
        }

        console.warn('[CALLBACK] Parametreler ayrıştırılıyor...');
        const paramList = String(hashParams).split(':');
        let digestData = '';

        for (const param of paramList) {
            if(!param) continue;
            const keyLower = param.toLowerCase();
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === keyLower);
            const value = foundKey ? postBody[foundKey] : '';
            digestData += value;
        }

        digestData += storeKey;

        const calculatedHash = crypto.createHash('sha512')
            .update(digestData, 'utf8')
            .digest('hex')
            .toUpperCase();

        const result = (responseHash === calculatedHash);
        console.warn(`[CALLBACK-SONUÇ] Hash Doğrulama: ${result}`);
        return result;

    } catch (e) {
        console.error('[CALLBACK-EXCEPTION]', e);
        return false;
    }
}

export function isApproved(postBody) {
    const procReturnCode = String(postBody.procreturncode || postBody.ProcReturnCode || '');
    console.warn(`[ONAY KONTROL] Kod: ${procReturnCode}`);
    return procReturnCode === '00';
}