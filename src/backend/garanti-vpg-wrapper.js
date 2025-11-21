import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- DOKÜMANA BAĞLI FORMATLAMA FONKSİYONLARI ---

function cleanStr(str) {
    return String(str || '').trim();
}

// [DOKÜMAN PHP REFERANSI]: sha1($password . str_pad($terminalId, 9, 0, STR_PAD_LEFT))
// Sadece şifre oluşturulurken Terminal ID 9 haneye tamamlanmalıdır.
function createHashedPassword(password, terminalId) {
    const terminalIdPadded = String(terminalId).trim().padStart(9, '0');
    const plain = password + terminalIdPadded;
    
    console.log('[DEBUG] HashedPassword Input (Padded Terminal ID):', plain);

    return crypto.createHash('sha1')
        .update(plain, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// [DOKÜMAN PHP REFERANSI]: hash('sha512', $terminalId . $orderId ... )
// PHP değişken mantığına göre burada $terminalId ham haliyle (padlenmeden) kullanılır.
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

    console.log('------------------------------------------------');
    console.log('[DEBUG] OUTGOING HASH STRING (SHA512):');
    console.log(plainText);
    console.log('------------------------------------------------');

    return crypto.createHash('sha512')
        .update(plainText, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// =========================================================
// FORM OLUŞTURMA (BANKA MODELİ: 3D_OOS_FULL)
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

    // 1. VERİ TEMİZLİĞİ
    const terminalIdRaw = cleanStr(rawTerminalId); // DOKÜMAN: HTML formunda 8 hane görünüyor
    const passwordClean = cleanStr(password);
    const storeKeyClean = cleanStr(rawStoreKey);

    // 2. TUTAR FORMATI
    // Dokümanda: value="100" görünüyor. Garanti VPG 100.00 formatını da kabul eder.
    // Wix'ten gelen kuruşlu tutarı (örn: 1250) -> "12.50" formatına çeviriyoruz.
    const amountNum = Number(amountMinor) / 100;
    const amountClean = amountNum.toFixed(2); 

    // 3. PARA BİRİMİ
    // Dokümanda: value="949"
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);

    // 4. TAKSİT
    // DOKÜMAN (HTML): value="" (Boş string)
    // Peşin işlemde taksit değeri boş gönderilmeli.
    const taksit = (installments && installments !== '1' && installments !== '0') ? String(installments) : '';

    // 5. İŞLEM TİPİ
    const typeStr = txnType || 'sales';

    // 6. ZAMAN DAMGASI
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 7. ŞİFRE HASHLEME (TERMİNAL ID PADLENECEK)
    const hashedPassword = createHashedPassword(passwordClean, terminalIdRaw);

    // 8. ANA HASH (TERMİNAL ID HAM KULLANILACAK - HTML İLE EŞLEŞMELİ)
    const hash = createSecure3DHash({
        terminalId: terminalIdRaw, // DİKKAT: Padlenmemiş raw ID
        orderId,
        amount: amountClean,
        currency: currencyCode,
        okUrl,
        failUrl,
        txnType: typeStr,
        installments: taksit, // DİKKAT: Boş string
        storeKey: storeKeyClean,
        hashedPassword
    });

    const cleanBase = String(gatewayUrl || 'https://sanalposprov.garanti.com.tr').replace(/\/+$/, '');
    const actionUrl = cleanBase.includes('gt3dengine') ? cleanBase : `${cleanBase}/servlet/gt3dengine`;

    // 9. FORM ALANLARI
    const formFields = {
        mode: 'PROD',
        apiversion: 'v0.01',
        secure3dsecuritylevel: '3D_OOS_FULL',
        terminalprovuserid: 'PROVOOS',
        terminaluserid: 'PROVOOS',
        terminalmerchantid: cleanStr(merchantId),
        terminalid: terminalIdRaw, // FORMDA HAM ID (HTML Örneğine Uygun)
        orderid: orderId,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        txnamount: amountClean,
        txncurrencycode: currencyCode,
        txntype: typeStr,
        txninstallmentcount: taksit, // FORMDA BOŞ STRING
        successurl: okUrl,
        errorurl: failUrl,
        txntimestamp: timestamp,
        secure3dhash: hash,
        lang: 'tr'
    };

    return { actionUrl, formFields };
}

// =========================================================
// DÖNÜŞ KONTROLÜ (C# ÖRNEĞİNE TAM UYUM)
// =========================================================

export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const storeKey = cleanStr(rawStoreKey);

        const responseHash = postBody.hash || postBody.HASH || postBody.secure3dhash;
        const hashParams = postBody.hashparams || postBody.hashParams || postBody.HASHPARAMS;

        if (!responseHash || !hashParams) {
            console.warn('[DEBUG] Callback: HashParams eksik. İşlem bankadan reddedilmiş olabilir.');
            return false;
        }

        // C# Kodu: responseHashparams.Split(separator)
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

        const isValid = (responseHash === calculatedHash);

        if (!isValid) {
            console.log(`[DEBUG] Hash Uyuşmazlığı: \nBeklenen: ${calculatedHash} \nGelen: ${responseHash}`);
        } else {
            console.log('[DEBUG] Hash Doğrulandı (Banka Onaylı)');
        }

        return isValid;

    } catch (e) {
        console.error('[DEBUG] Verify Error:', e);
        return false;
    }
}

export function isApproved(postBody) {
    const procReturnCode = String(postBody.procreturncode || postBody.ProcReturnCode || '');
    return procReturnCode === '00';
}