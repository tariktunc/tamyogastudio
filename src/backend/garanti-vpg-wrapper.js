import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- HELPER: Store Key Normalization ---
function normalizeStoreKey(key) {
    const trimmedKey = String(key || '').trim();
    // Hex kontrolü ve dönüşümü gerekiyorsa burası aktif edilebilir
    // Şimdilik raw gönderiyoruz.
    return trimmedKey;
}

// --- HELPER: Password Hashing (SHA1) ---
// Dokümana göre: SHA1(Password + TerminalID_Padded) -> UpperCase
function createHashedPassword(password, terminalId) {
    const terminalIdEffective = String(terminalId).padStart(9, '0');
    const plain = password + terminalIdEffective;
    
    console.log('[DEBUG] HashedPassword Plain:', plain);

    return crypto.createHash('sha1')
        .update(plain, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// --- HELPER: Main 3D Hash Construction (SHA512) ---
// Dokümana göre sıra: TerminalID + OrderID + Amount + CurrencyCode + SuccessUrl + ErrorUrl + Type + Installment + StoreKey + HashedPassword
function createSecure3DHash({ terminalId, orderId, amount, currency, okUrl, failUrl, txnType, installments, storeKey, hashedPassword }) {
    const plainText = 
        terminalId +
        orderId +
        amount +
        currency +   // EKLENDİ: Dokümanda currencyCode var
        okUrl +
        failUrl +
        txnType +
        installments +
        storeKey +
        hashedPassword;

    console.log('------------------------------------------------');
    console.log('[DEBUG] HASH STRING (SHA512):');
    console.log(plainText);
    console.log('------------------------------------------------');

    // DÜZELTİLDİ: Algoritma SHA512 yapıldı
    return crypto.createHash('sha512')
        .update(plainText, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// =========================================================
// 3D CALLBACK VERIFICATION
// =========================================================

export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        
        // Dokümana göre dönüşte secure3dhash veya hash parametresi gelir
        const receivedHash = postBody.secure3dhash || postBody.hash || postBody.HASH; 
        const hashParams = postBody.hashparams || postBody.hashParams;

        if (!receivedHash || !rawStoreKey) {
            console.warn('[DEBUG] Callback Verify: Missing hash or store key.');
            return false;
        }

        const storeKey = normalizeStoreKey(rawStoreKey);

        let paramsList = [];
        if (hashParams) {
            // Banka hashparams gönderdiyse o sıraya göre birleştir
            paramsList = String(hashParams).split(':').filter(Boolean);
        } else {
            // Göndermediyse standart Garanti dönüş parametrelerini dene
            // Not: Dönüş hash algoritması gönderimden farklı olabilir (genelde SHA512)
            paramsList = [
                'clientid', 'oid', 'authcode', 'procreturncode', 'mdstatus',
                'txnamount', 'txncurrencycode', 'txntimestamp'
            ];
        }

        let plainText = '';
        for (const param of paramsList) {
            const keyLower = param.toLowerCase();
            // Gelen postBody içindeki key'leri case-insensitive ara
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === keyLower);
            const val = foundKey ? postBody[foundKey] : '';
            plainText += val;
        }

        plainText += storeKey;

        // Garanti dönüşte genellikle SHA512 kullanır
        const calculatedHash = crypto.createHash('sha512')
            .update(plainText, 'utf8')
            .digest('hex')
            .toUpperCase();

        // Bazen base64 gelebilir, hex tutmazsa base64 dene
        const calculatedHashBase64 = crypto.createHash('sha512')
            .update(plainText, 'utf8')
            .digest('base64');

        const isValid = (receivedHash === calculatedHash) || (receivedHash === calculatedHashBase64);

        console.log(`[DEBUG] Callback Hash Check: ${isValid}`);
        if(!isValid) {
             console.log(`[DEBUG] Calculated (Hex): ${calculatedHash}`);
             console.log(`[DEBUG] Received: ${receivedHash}`);
        }

        return isValid;
    } catch (e) {
        console.error('[DEBUG] Verify Error:', e);
        return false;
    }
}

// =========================================================
// BUILD PAY FORM
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
        getSecret('GARANTI_CALLBACK_PATH') // veya GARANTI_GATEWAY_URL
    ]);

    const provUserId = "PROVOOS"; // Veya secret'tan alabilirsin

    if (!rawTerminalId || !rawStoreKey || !password) throw new Error('Garanti Secrets missing!');

    const terminalIdRaw = String(rawTerminalId).trim();
    const terminalIdToSend = terminalIdRaw.padStart(9, '0');

    // Amount kuruş cinsinden değil, 1.00 formatında string olmalı mı?
    // Garanti VPG genelde 12.50 formatı ister. Kodun önceki hali minor/100 yapıyordu
    // amountMinor buraya kuruş geliyor (10000), bunu 100.00 yapmalıyız
    // Eğer zaten formatlı geliyorsa kontrol et.
    
    // amountMinor'ı string olarak "100.00" formatına çevirelim (Garanti bunu sever)
    // Ancak hash fonksiyonunda nokta olup olmaması banka ayarına göre değişir.
    // Standart VPG: 1.00 şeklindedir.
    const amountNum = Number(amountMinor) / 100;
    const amountClean = amountNum.toFixed(2); // "100.00"

    const taksit = (installments && installments !== '1' && installments !== '0') ? String(installments) : ''; // Boş string gönderilmeli 0 yerine

    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    const hashedPassword = createHashedPassword(password, terminalIdToSend);
    const storeKey = normalizeStoreKey(rawStoreKey);
    
    // DÜZELTİLDİ: Currency ve SHA512 kullanımı
    const hash = createSecure3DHash({
        terminalId: terminalIdToSend,
        orderId,
        amount: amountClean,
        currency: currency, // EKLENDİ
        okUrl,
        failUrl,
        txnType,
        installments: taksit,
        storeKey,
        hashedPassword
    });

    const cleanBase = String(gatewayUrl || 'https://sanalposprov.garanti.com.tr').replace(/\/+$/, '');
    // Gateway URL genellikle şudur: https://sanalposprov.garanti.com.tr/servlet/gt3dengine
    // Eğer secret sadece base ise sonuna ekle:
    const actionUrl = cleanBase.includes('gt3dengine') ? cleanBase : `${cleanBase}/servlet/gt3dengine`;

    const formFields = {
        mode: 'PROD',
        apiversion: 'v0.01',
        terminalprovuserid: provUserId,
        terminaluserid: provUserId,
        terminalmerchantid: merchantId,
        terminalid: terminalIdToSend,
        orderid: orderId,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        txnamount: amountClean,
        txncurrencycode: currency,
        txntype: txnType,
        txninstallmentcount: taksit,
        successurl: okUrl,
        errorurl: failUrl,
        secure3dsecuritylevel: '3D_OOS_FULL', // Veya '3D'
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

    // MD Status 1,2,3,4 başarılı sayılır
    const mdOk = ['1', '2', '3', '4'].includes(mdStatus);
    const prcOk = procReturnCode === '00' || response.toLowerCase() === 'approved';

    return mdOk && prcOk;
}