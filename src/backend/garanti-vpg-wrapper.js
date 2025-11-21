import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- YARDIMCI FONKSİYONLAR ---

function cleanStr(str) {
    return String(str || '').trim();
}

// [ŞİFRE HASHLEME]: SHA1(Password + 9 Haneli TerminalID)
function createHashedPassword(password, terminalId) {
    const terminalIdPadded = String(terminalId).trim().padStart(9, '0');
    const plain = password + terminalIdPadded;
    return crypto.createHash('sha1').update(plain, 'utf8').digest('hex').toUpperCase();
}

// [ANA HASH]: SHA512
function createSecure3DHash({ terminalId, orderId, amount, currency, okUrl, failUrl, typeForHash, installForHash, storeKey, hashedPassword }) {
    const plainText = 
        terminalId +
        orderId +
        amount +
        currency +
        okUrl +
        failUrl +
        typeForHash +    // DİKKAT: PHP Örneğine göre burası boş ("") olmalı
        installForHash + // DİKKAT: PHP Örneğine göre peşin ise "0" olmalı
        storeKey +
        hashedPassword;

    console.log('------------------------------------------------');
    console.log('[DEBUG] OUTGOING HASH STRING (SHA512):');
    console.log(plainText);
    console.log('------------------------------------------------');

    return crypto.createHash('sha512').update(plainText, 'utf8').digest('hex').toUpperCase();
}

// =========================================================
// FORM OLUŞTURMA (3D_OOS_FULL - PHP & HTML HİBRİT MANTIK)
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
    
    // Tutar: "100.00" formatı
    const amountNum = Number(amountMinor) / 100;
    const amountClean = amountNum.toFixed(2); 
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);

    // --- KRİTİK AYRIM: FORM vs HASH ---

    // 1. TAKSİT MANTIĞI
    let installForForm = ''; // HTML: Peşin ise boş
    let installForHash = '0'; // PHP: Peşin ise "0"
    
    if (installments && installments !== '0' && installments !== '1') {
        installForForm = String(installments);
        installForHash = String(installments);
    }

    // 2. İŞLEM TİPİ MANTIĞI
    const typeForForm = txnType || 'sales'; // HTML: "sales" olmalı
    const typeForHash = ''; // PHP Örneğinde $type = ""; olarak kodlanmış. Hash'e boş girmeli.

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
        typeForHash: typeForHash,       // Hash'e BOŞ gidiyor
        installForHash: installForHash, // Hash'e "0" gidiyor (Peşin ise)
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
        txntype: typeForForm,            // Form'a "sales" gidiyor
        txninstallmentcount: installForForm, // Form'a "" gidiyor (Peşin ise)
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
            console.warn('[DEBUG] Callback: HashParams eksik. Banka red cevabı döndü.');
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

        const calculatedHash = crypto.createHash('sha512')
            .update(digestData, 'utf8')
            .digest('hex')
            .toUpperCase();

        return (responseHash === calculatedHash);

    } catch (e) {
        console.error('[DEBUG] Verify Error:', e);
        return false;
    }
}

export function isApproved(postBody) {
    const procReturnCode = String(postBody.procreturncode || postBody.ProcReturnCode || '');
    return procReturnCode === '00';
}