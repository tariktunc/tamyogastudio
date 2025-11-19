import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- HELPER: Store Key Normalization & Logging ---
function normalizeStoreKey(key) {
    const trimmedKey = String(key || '').trim();
    console.log('[DEBUG] Raw Store Key (First 4 chars):', trimmedKey.substring(0, 4) + '...');

    // Hex Kontrolü: Sadece 0-9, A-F ve çift uzunluk
    const isHex = /^[0-9A-Fa-f]+$/.test(trimmedKey) && (trimmedKey.length % 2 === 0);
    
    if (isHex) {
        try {
            const decoded = Buffer.from(trimmedKey, 'hex').toString('utf8');
            console.log('[DEBUG] Store Key: HEX detected & decoded.');
            return decoded;
        } catch (e) {
            console.warn('[DEBUG] Store Key: Hex decode failed, using raw.');
            return trimmedKey;
        }
    }
    console.log('[DEBUG] Store Key: Treated as PLAIN TEXT.');
    return trimmedKey;
}

// --- HELPER: Password Hashing (SHA1) ---
function createHashedPassword(password, terminalId) {
    // Terminal ID her zaman 9 hane olmalı (Solu sıfır dolgulu)
    const terminalIdPadded = String(terminalId).padStart(9, '0');
    const plain = password + terminalIdPadded;
    
    // KRİTİK LOG 1: Şifre Hashlenmeden önceki hali
    console.log('------------------------------------------------');
    console.log('[DEBUG] HashedPassword Input (Plain):', plain);
    console.log('------------------------------------------------');

    return crypto.createHash('sha1').update(plain, 'utf8').digest('hex').toUpperCase();
}

// --- HELPER: Main 3D Hash Construction ---
function createSecure3DHash({ terminalId, orderId, amount, okUrl, failUrl, txnType, installments, storeKey, hashedPassword }) {
    // Sıralama: TerminalID + OrderID + Amount + OkUrl + FailUrl + Type + Installment + StoreKey + HashedPassword
    const plainText = 
        terminalId +
        orderId +
        amount +
        okUrl +
        failUrl +
        txnType +
        installments +
        storeKey +
        hashedPassword;

    // KRİTİK LOG 2: Ana Hash String'i (Banka ile burası eşleşmeli)
    console.log('------------------------------------------------');
    console.log('[DEBUG] MAIN HASH STRING TO SIGN:');
    console.log(plainText);
    console.log('------------------------------------------------');

    return crypto.createHash('sha1').update(plainText, 'utf8').digest('hex').toUpperCase();
}

/**
 * Callback Hash Doğrulama (Debug Loglu)
 */
export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const receivedHash = postBody.HASH || postBody.hash;
        const hashParams = postBody.hashparams || postBody.hashParams;

        if (!receivedHash || !hashParams || !rawStoreKey) {
            console.warn('[DEBUG] Callback Verify: Eksik parametreler.');
            return false;
        }

        const storeKey = normalizeStoreKey(rawStoreKey);
        const paramsList = String(hashParams).split(':').filter(Boolean);
        let plainText = '';

        // HashParams sırasına göre değerleri topla
        for (const param of paramsList) {
            const keyLower = param.toLowerCase();
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === keyLower);
            const val = foundKey ? postBody[foundKey] : '';
            plainText += val;
        }

        plainText += storeKey;
        
        // KRİTİK LOG 3: Dönüş Hash String'i
        console.log('[DEBUG] Callback Verify String:', plainText);

        const calculatedHash = crypto.createHash('sha1').update(plainText, 'utf8').digest('base64');
        
        const isValid = (receivedHash === calculatedHash);
        console.log(`[DEBUG] Hash Match Result: ${isValid} (Rec: ${receivedHash} vs Calc: ${calculatedHash})`);
        
        return isValid;
    } catch (e) {
        console.error('[DEBUG] Verify Error:', e);
        return false;
    }
}

// --- ANA FONKSİYON ---

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
    // 1. Secret'ları Çek
    const [rawTerminalId, merchantId, password, rawStoreKey, provUserId, gatewayUrl] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'),
        getSecret('GARANTI_ENC_KEY'),
        getSecret('GARANTI_PROVOOS_ID'),
        getSecret('GARANTI_CALLBACK_PATH')
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) throw new Error('Garanti Secretları eksik!');

    // 2. Terminal ID Kontrolü (Loglu)
    // Garanti genellikle 9 hane ister (001234567). Secret'ta 7 veya 8 hane olabilir.
    const terminalId = String(rawTerminalId).padStart(9, '0');
    
    console.log('------------------------------------------------');
    console.log('[DEBUG] Terminal ID Check:');
    console.log(`Raw (Secrets): "${rawTerminalId}"`);
    console.log(`Padded (Used): "${terminalId}"`);
    console.log('------------------------------------------------');

    // 3. Veri Formatlaması
    const amountMajor = (parseInt(String(amountMinor), 10) / 100).toFixed(2);
    // Taksit boşsa, '1' ise veya '0' ise hash hesaplamasına boş string olarak girer
    const taksit = (installments && installments !== '1' && installments !== '0') ? String(installments) : '';
    
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 4. Hash Hesaplama Adımları
    const hashedPassword = createHashedPassword(password, terminalId);
    const storeKey = normalizeStoreKey(rawStoreKey);

    const hash = createSecure3DHash({
        terminalId, // Padded (9 digit) gönderiliyor
        orderId,
        amount: amountMajor,
        okUrl,
        failUrl,
        txnType,
        installments: taksit,
        storeKey,
        hashedPassword
    });

    // 5. Endpoint
    const cleanBase = String(gatewayUrl || 'https://sanalposprov.garanti.com.tr').replace(/\/+$/, '');
    const actionUrl = `${cleanBase}/servlet/gt3dengine`;

    // 6. Form Alanları
    const formFields = {
        mode: 'PROD',
        apiversion: 'v0.01',
        terminalprovuserid: provUserId,
        terminaluserid: provUserId,
        terminalmerchantid: merchantId,
        terminalid: terminalId, // Bankaya padded versiyonu gönderiyoruz
        orderid: orderId,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        txnamount: amountMajor,
        txncurrencycode: currency,
        txntype: txnType,
        txninstallmentcount: taksit,
        successurl: okUrl,
        errorurl: failUrl,
        secure3dsecuritylevel: '3D_OOS_FULL',
        txntimestamp: timestamp,
        secure3dhash: hash,
        lang: 'tr'
    };

    return { actionUrl, formFields };
}

export function isApproved(postBody) {
    const mdStatus = String(postBody.mdstatus || postBody.MDStatus || '');
    const procReturnCode = String(postBody.procreturncode || postBody.ProcReturnCode || '');
    const response = String(postBody.response || postBody.Response || '');
    
    const mdOk = ['1', '2', '3', '4'].includes(mdStatus);
    const prcOk = procReturnCode === '00' || response.toLowerCase() === 'approved';

    return mdOk && prcOk;
}