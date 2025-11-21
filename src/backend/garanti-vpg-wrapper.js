import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- YARDIMCI FONKSİYONLAR ---

function cleanStr(str) {
    return String(str || '').trim();
}

// [1. ADIM] ŞİFRE HASHLEME (SHA1)
function createHashedPassword(password, terminalId) {
    const terminalIdPadded = String(terminalId).trim().padStart(9, '0');
    const plain = password + terminalIdPadded;
    
    console.warn(`[DEBUG] HashedPass Input: ${password.substring(0,2)}*** + ${terminalIdPadded}`);

    return crypto.createHash('sha1')
        .update(plain, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// [2. ADIM] ANA HASH OLUŞTURMA (SHA512)
// KURAL: Form'a giden değerlerle BİREBİR AYNI olmalı.
function createSecure3DHash({ terminalId, orderId, amount, currency, okUrl, failUrl, txnType, installments, storeKey, hashedPassword }) {
    const plainText = 
        terminalId +
        orderId +
        amount +
        currency +
        okUrl +
        failUrl +
        txnType +      // Form'da "sales" ise burada da "sales"
        installments + // Form'da boş ise burada da boş
        storeKey +
        hashedPassword;

    console.warn('------------------------------------------------');
    console.warn('[DEBUG] HASH STRING (Tam Eşleşme Mantığı):');
    console.warn(plainText);
    console.warn('------------------------------------------------');

    return crypto.createHash('sha512')
        .update(plainText, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// =========================================================
// FORM OLUŞTURMA (3D_OOS_PAY / API 512)
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
        getSecret('GARANTI_TERMINAL_ID'),       // 30691297
        getSecret('GARANTI_STORE_NO'),          // 7000679
        getSecret('GARANTI_TERMINAL_PASSWORD'), // 123qweASD/
        getSecret('GARANTI_ENC_KEY'),           // 12345678
        getSecret('GARANTI_CALLBACK_PATH')      // https://sanalposprovtest.garantibbva.com.tr
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) throw new Error('Garanti Secrets missing!');

    const terminalIdRaw = cleanStr(rawTerminalId);
    const passwordClean = cleanStr(password);
    const storeKeyClean = cleanStr(rawStoreKey);
    
    const amountNum = Number(amountMinor) / 100;
    const amountClean = amountNum.toFixed(2); 
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);

    // --- DÜZELTME: TAM EŞLEŞME ---

    // 1. TAKSİT:
    // Peşin (veya 1) ise -> "" (BOŞ)
    // Taksitli (3,6 vb) ise -> "3"
    let finalInstallment = '';
    if (installments && installments !== '0' && installments !== '1') {
        finalInstallment = String(installments);
    }

    // 2. İŞLEM TİPİ:
    // Her zaman "sales"
    const finalType = txnType || 'sales';

    // Zaman Damgası
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // Hash Hesaplama
    const hashedPassword = createHashedPassword(passwordClean, terminalIdRaw);

    const hash = createSecure3DHash({
        terminalId: terminalIdRaw,
        orderId,
        amount: amountClean,
        currency: currencyCode,
        okUrl,
        failUrl,
        txnType: finalType,            // "sales" (Hash'e giriyor)
        installments: finalInstallment,// "" (Hash'e giriyor)
        storeKey: storeKeyClean,
        hashedPassword
    });

    const cleanBase = String(gatewayUrl || 'https://sanalposprovtest.garantibbva.com.tr').replace(/\/+$/, '');
    const actionUrl = cleanBase.includes('gt3dengine') ? cleanBase : `${cleanBase}/servlet/gt3dengine`;

    const formFields = {
        mode: 'TEST',
        apiversion: '512',
        secure3dsecuritylevel: '3D_OOS_PAY',
        terminalprovuserid: 'PROVAUT',
        terminaluserid: 'PROVAUT',
        terminalmerchantid: cleanStr(merchantId),
        terminalid: terminalIdRaw,
        orderid: orderId,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        txnamount: amountClean,
        txncurrencycode: currencyCode,
        txntype: finalType,             // "sales" (Forma giriyor)
        txninstallmentcount: finalInstallment, // "" (Forma giriyor)
        successurl: okUrl,
        errorurl: failUrl,
        txntimestamp: timestamp,
        secure3dhash: hash,
        lang: 'tr'
    };

    return { actionUrl, formFields };
}

// =========================================================
// DÖNÜŞ KONTROLÜ
// =========================================================

export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const storeKey = cleanStr(rawStoreKey);
        const responseHash = postBody.hash || postBody.HASH || postBody.secure3dhash;
        const hashParams = postBody.hashparams || postBody.hashParams || postBody.HASHPARAMS;

        if (!responseHash || !hashParams) {
            console.warn('[DEBUG] Callback: HashParams eksik.');
            return false;
        }

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