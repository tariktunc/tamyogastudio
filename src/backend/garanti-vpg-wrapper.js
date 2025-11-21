import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- YARDIMCI: String Temizleme ---
function cleanStr(str) {
    return String(str || '').trim();
}

// [1. ADIM] ŞİFRE HASHLEME
function createHashedPassword(password, terminalId) {
    const terminalIdPadded = String(terminalId).trim().padStart(9, '0');
    const plain = password + terminalIdPadded;
    
    // Loglarda şifre uzunluğunu kontrol edelim (Sondaki / karakteri var mı?)
    console.warn(`[ADIM 5] Şifre Uzunluğu: ${password.length} (Beklenen: 10)`);

    return crypto.createHash('sha1')
        .update(plain, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// [2. ADIM] ANA HASH OLUŞTURMA
function createSecure3DHash({ terminalId, orderId, amount, currency, okUrl, failUrl, txnType, installments, storeKey, hashedPassword }) {
    
    // DÜZELTME: Taksit artık zorunlu "0" geliyor.
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
    console.warn('[ADIM 7-KRİTİK] HASH STRING (Installment 0 Kontrolü):');
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
    const [rawTerminalId, merchantId, password, rawStoreKey, gatewayUrl] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'),
        getSecret('GARANTI_ENC_KEY'),
        getSecret('GARANTI_CALLBACK_PATH')
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) throw new Error('Garanti Secrets missing!');

    const terminalIdRaw = cleanStr(rawTerminalId);
    const passwordClean = cleanStr(password);
    const storeKeyClean = cleanStr(rawStoreKey);
    
    const amountNum = Number(amountMinor) / 100;
    const amountClean = amountNum.toFixed(2); 
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);

    // --- DÜZELTME (GERİ ALINDI): TAKSİT ZORUNLU "0" ---
    // HTML'de "" yazsa bile Banka algoritması "0" istiyor.
    // Peşin (veya boş) ise "0", Taksitli ise "3" vb.
    const finalInstallment = (installments && installments !== '0' && installments !== '1') ? String(installments) : '0';

    const finalType = txnType || 'sales';
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    const hashedPassword = createHashedPassword(passwordClean, terminalIdRaw);

    const hash = createSecure3DHash({
        terminalId: terminalIdRaw,
        orderId,
        amount: amountClean,
        currency: currencyCode,
        okUrl,
        failUrl,
        txnType: finalType,
        installments: finalInstallment, // Burası artık "0"
        storeKey: storeKeyClean,
        hashedPassword
    });

    const cleanBase = String(gatewayUrl || 'https://sanalposprovtest.garantibbva.com.tr').replace(/\/+$/, '');
    const actionUrl = cleanBase.includes('gt3dengine') ? cleanBase : `${cleanBase}/servlet/gt3dengine`;

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
        txninstallmentcount: finalInstallment, // Form'a da "0" basılacak
        successurl: okUrl,
        errorurl: failUrl,
        txntimestamp: timestamp,
        secure3dhash: hash,
        lang: 'tr'
    };

    return { actionUrl, formFields };
}

// ... (Callback ve Onay fonksiyonları aynı kalacak)
export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const storeKey = cleanStr(rawStoreKey);
        const responseHash = postBody.hash || postBody.HASH || postBody.secure3dhash;
        const hashParams = postBody.hashparams || postBody.hashParams || postBody.HASHPARAMS;

        if (!responseHash || !hashParams) return false;

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
        const calculatedHash = crypto.createHash('sha512').update(digestData, 'utf8').digest('hex').toUpperCase();
        return (responseHash === calculatedHash);
    } catch (e) { return false; }
}

export function isApproved(postBody) {
    const procReturnCode = String(postBody.procreturncode || postBody.ProcReturnCode || '');
    return procReturnCode === '00';
}