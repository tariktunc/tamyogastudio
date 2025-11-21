import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- YARDIMCI FONKSİYONLAR ---

function cleanStr(str) {
    return String(str || '').trim();
}

// [ADIM 1] ŞİFRE HASHLEME (SHA1)
function createHashedPassword(password, terminalId) {
    const terminalIdPadded = String(terminalId).trim().padStart(9, '0');
    const plain = password + terminalIdPadded;
    
    console.warn(`[DEBUG] HashedPass Input: ${password.substring(0,2)}*** + ${terminalIdPadded}`);

    return crypto.createHash('sha1')
        .update(plain, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// [ADIM 2] ANA HASH OLUŞTURMA (SHA512)
function createSecure3DHash({ terminalId, orderId, amount, currency, okUrl, failUrl, txnType, installments, storeKey, hashedPassword }) {
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
    console.warn('[DEBUG] HASH STRING (Taksit=1, Tutar=TamSayı):');
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
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);
    
    // --- DÜZELTME: TUTAR FORMATI (TAM SAYI) ---
    // Wix'ten gelen 4535000 (Kuruş) -> 45350 (TL Tam Sayı)
    // Nokta veya Kuruş gönderilmiyor.
    const amountNum = Math.floor(Number(amountMinor) / 100);
    const amountClean = String(amountNum); // "45350"

    // --- DÜZELTME: TAKSİT (1) ---
    // threed-payment.php dosyasına göre peşin işlem "1" olmalı.
    let finalInstallment = '1';
    if (installments && installments !== '0' && installments !== '1' && installments !== '') {
        finalInstallment = String(installments);
    }

    // İŞLEM TİPİ: "sales"
    const finalType = txnType || 'sales';

    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    const hashedPassword = createHashedPassword(passwordClean, terminalIdRaw);

    const hash = createSecure3DHash({
        terminalId: terminalIdRaw,
        orderId,
        amount: amountClean,     // "45350"
        currency: currencyCode,
        okUrl,
        failUrl,
        txnType: finalType,      // "sales"
        installments: finalInstallment, // "1"
        storeKey: storeKeyClean,
        hashedPassword
    });

    // URL: gt3dengine
    let actionUrl = 'https://sanalposprovtest.garantibbva.com.tr/servlet/gt3dengine';
    if (gatewayUrl) {
        let base = String(gatewayUrl).replace('/VPServlet', '').replace('/servlet/gt3dengine', '').replace(/\/+$/, '');
        if(base.includes('garanti.com.tr') && !base.includes('garantibbva')) {
            base = base.replace('garanti.com.tr', 'garantibbva.com.tr');
        }
        actionUrl = `${base}/servlet/gt3dengine`;
    }

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
        txnamount: amountClean,         // "45350"
        txncurrencycode: currencyCode,
        txntype: finalType,
        txninstallmentcount: finalInstallment, // "1"
        successurl: okUrl,
        errorurl: failUrl,
        txntimestamp: timestamp,
        secure3dhash: hash,
        lang: 'tr'
    };

    return { actionUrl, formFields };
}

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