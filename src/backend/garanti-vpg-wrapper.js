import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- YARDIMCI FONKSİYONLAR ---

function cleanStr(str) {
    return String(str || '').trim();
}

// [DOKÜMAN KURALI]: Password Hashlenirken Terminal ID 9 haneye (soluna 0 eklenerek) tamamlanır.
// SHA1(Password + 030691297) -> UpperCase
function createHashedPassword(password, terminalId) {
    // Gelen 30691297 (8 hane) -> 030691297 (9 hane) olur.
    const terminalIdPadded = String(terminalId).trim().padStart(9, '0');
    const plain = password + terminalIdPadded;
    
    console.log('[DEBUG] HashedPassword Input (Plain):', plain);

    return crypto.createHash('sha1')
        .update(plain, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// [DOKÜMAN KURALI]: Ana Hash dizisinde Terminal ID orijinal haliyle (8 hane) kullanılır.
// SHA512(30691297 + OrderID + ...) -> UpperCase
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
// FORM OLUŞTURMA (TABLO VERİLERİNE GÖRE)
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
    // 1. Secret Değerlerini Çek
    const [rawTerminalId, merchantId, password, rawStoreKey, gatewayUrl] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),       // Beklenen: 30691297
        getSecret('GARANTI_STORE_NO'),          // Beklenen: 7000679
        getSecret('GARANTI_TERMINAL_PASSWORD'), // Beklenen: 123qweASD/
        getSecret('GARANTI_ENC_KEY'),           // Beklenen: 12345678
        getSecret('GARANTI_CALLBACK_PATH')      // Beklenen: https://sanalposprovtest.garanti.com.tr
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) throw new Error('Garanti Secrets missing!');

    // 2. Veri Temizliği ve Formatlama
    const terminalIdRaw = cleanStr(rawTerminalId); // "30691297"
    const passwordClean = cleanStr(password);      // "123qweASD/"
    const storeKeyClean = cleanStr(rawStoreKey);   // "12345678"
    
    // Tutar: 100 -> "1.00" veya "100.00". Garanti Test ortamı genelde 100.00 ister.
    const amountNum = Number(amountMinor) / 100;
    const amountClean = amountNum.toFixed(2); 

    // Para Birimi: Tabloda yok ama standart 949
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);

    // Taksit: Peşin işlem için boş string
    const taksit = (installments && installments !== '1' && installments !== '0') ? String(installments) : '';

    // İşlem Tipi
    const typeStr = txnType || 'sales';

    // Zaman Damgası
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 3. HashedPassword Oluşturma
    // Burada Terminal ID pad'lenir (9 hane yapılır)
    const hashedPassword = createHashedPassword(passwordClean, terminalIdRaw);

    // 4. Ana Hash Oluşturma
    // Burada Terminal ID raw (8 hane) kullanılır
    const hash = createSecure3DHash({
        terminalId: terminalIdRaw,
        orderId,
        amount: amountClean,
        currency: currencyCode,
        okUrl,
        failUrl,
        txnType: typeStr,
        installments: taksit,
        storeKey: storeKeyClean,
        hashedPassword
    });

    const cleanBase = String(gatewayUrl || 'https://sanalposprovtest.garanti.com.tr').replace(/\/+$/, '');
    const actionUrl = cleanBase.includes('gt3dengine') ? cleanBase : `${cleanBase}/servlet/gt3dengine`;

    // 5. Form Alanları (Tabloya Uygun Kullanıcı Adları ile)
    const formFields = {
        mode: 'TEST',                        // Test ortamı olduğu için TEST (Canlıda PROD olacak)
        apiversion: 'v0.01',                 
        secure3dsecuritylevel: '3D_OOS_FULL',
        terminalprovuserid: 'PROVAUT',       // TABLO VE HTML'DEKİ DEĞER
        terminaluserid: 'PROVAUT',           // TABLO VE HTML'DEKİ DEĞER
        terminalmerchantid: cleanStr(merchantId),
        terminalid: terminalIdRaw,           // 8 Haneli ID
        orderid: orderId,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        txnamount: amountClean,
        txncurrencycode: currencyCode,
        txntype: typeStr,
        txninstallmentcount: taksit,
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
            console.warn('[DEBUG] Callback: HashParams eksik. Banka işlemi reddetti (Muhtemel Şifre Hatası).');
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

        const isValid = (responseHash === calculatedHash);

        if (!isValid) {
            console.log(`[DEBUG] Hash Uyuşmazlığı! \nCalc: ${calculatedHash} \nRecv: ${responseHash}`);
        } else {
            console.log('[DEBUG] Hash Doğrulandı.');
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