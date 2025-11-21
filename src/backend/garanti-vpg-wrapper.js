import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- YARDIMCI: String Temizleme ---
function cleanStr(str) {
    return String(str || '').trim();
}

// --- YARDIMCI: Password Hashing (SHA1) ---
// Doküman: SHA1(Password + TerminalID_Padded) -> UpperCase
function createHashedPassword(password, terminalId) {
    const terminalIdEffective = String(terminalId).trim().padStart(9, '0');
    const plain = password + terminalIdEffective;
    
    console.log('[DEBUG] HashedPassword Input:', plain);

    return crypto.createHash('sha1')
        .update(plain, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// --- YARDIMCI: GÖNDERİM İÇİN HASH (SHA512) ---
// Bu fonksiyon SADECE bankaya formu gönderirken kullanılır.
// Sıralama sabittir: TerminalID + OrderID + Amount + ...
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

    console.log('[DEBUG] OUTGOING HASH STRING:', plainText);

    return crypto.createHash('sha512')
        .update(plainText, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// =========================================================
// 1. BUILD PAY FORM (3D_OOS_FULL MODU)
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

    const terminalIdClean = cleanStr(rawTerminalId);
    const passwordClean = cleanStr(password);
    const storeKeyClean = cleanStr(rawStoreKey);
    const terminalIdToSend = terminalIdClean.padStart(9, '0');

    // Amount: "100.00" formatı
    const amountNum = Number(amountMinor) / 100;
    const amountClean = amountNum.toFixed(2); 

    // Currency: TRY -> 949
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);
    const taksit = (installments && installments !== '1' && installments !== '0') ? String(installments) : '';
    const typeStr = txnType || 'sales';

    // Zaman Damgası (Compact: YYYYMMDDHHmmss)
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // Hash Hesaplama (Gönderim)
    const hashedPassword = createHashedPassword(passwordClean, terminalIdToSend);
    const hash = createSecure3DHash({
        terminalId: terminalIdToSend,
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

    const cleanBase = String(gatewayUrl || 'https://sanalposprov.garanti.com.tr').replace(/\/+$/, '');
    const actionUrl = cleanBase.includes('gt3dengine') ? cleanBase : `${cleanBase}/servlet/gt3dengine`;

    const formFields = {
        mode: 'PROD',
        apiversion: 'v0.01',
        secure3dsecuritylevel: '3D_OOS_FULL',
        terminalprovuserid: 'PROVOOS',
        terminaluserid: 'PROVOOS',
        terminalmerchantid: cleanStr(merchantId),
        terminalid: terminalIdToSend,
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
// 2. CALLBACK VERIFICATION (DÖNÜŞ KONTROLÜ - C# ÇEVİRİSİ)
// =========================================================

export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const storeKey = cleanStr(rawStoreKey);

        // 1. Bankadan gelen Hash ve HashParams'ı al
        const responseHash = postBody.hash || postBody.HASH || postBody.secure3dhash;
        const hashParams = postBody.hashparams || postBody.hashParams || postBody.HASHPARAMS;

        // 2. Doküman Kuralı: "hashparams null veya boş olmamalı"
        if (!responseHash || !hashParams) {
            console.warn('[DEBUG] Callback Verify: Hash or HashParams is missing!');
            return false;
        }

        // 3. C# Mantığı: Parametreleri ':' ile ayır ve döngüye sok
        // char[] separator = new char[] { ':' };
        const paramList = String(hashParams).split(':');
        
        let digestData = '';

        // 4. Döngü ile değerleri topla
        for (const param of paramList) {
            // Boş parametre gelirse atla (split bazen boş string üretebilir)
            if(!param) continue;

            // Parametre adını küçük harfe çevirerek postBody içinde ara (Case-Insensitive bulmak için)
            // Çünkü hashParams 'ClientId' diyebilir ama postBody 'clientid' olabilir.
            const keyLower = param.toLowerCase();
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === keyLower);
            
            // C#: Request.Form.Get(param) == null ? "" : ...
            const value = foundKey ? postBody[foundKey] : '';
            
            digestData += value;
        }

        // 5. Sonuna Store Key ekle
        // C#: digestData += strStoreKey;
        digestData += storeKey;

        // 6. SHA512 Şifreleme
        // C#: sha.ComputeHash...
        const calculatedHash = crypto.createHash('sha512')
            .update(digestData, 'utf8') // Node.js genelde UTF8 çalışır
            .digest('hex')
            .toUpperCase();

        // 7. Karşılaştırma
        const isValid = (responseHash === calculatedHash);

        if (!isValid) {
            console.log('------------------------------------------------');
            console.log('[DEBUG] HASH MISMATCH!');
            console.log('Incoming HashParams:', hashParams);
            console.log('My Digest String:', digestData);
            console.log('My Calculated Hash:', calculatedHash);
            console.log('Bank Received Hash:', responseHash);
            console.log('------------------------------------------------');
        } else {
            console.log('[DEBUG] HASH VALIDATED SUCCESSFULY (Bankadan Geliyor)');
        }

        return isValid;

    } catch (e) {
        console.error('[DEBUG] Verify Error:', e);
        return false;
    }
}

// =========================================================
// 3. ONAY KONTROLÜ (Doküman Kuralı: Sadece 00)
// =========================================================

export function isApproved(postBody) {
    // Doküman: "Dönüş sadece 00 için kontrol yapılmalıdır."
    const procReturnCode = String(postBody.procreturncode || postBody.ProcReturnCode || '');
    const response = String(postBody.response || postBody.Response || '');

    // Kesin kural: procReturnCode "00" olmalı.
    // Ekstra güvenlik olarak Response "Approved" mu diye de bakabiliriz ama "00" esastır.
    const isSuccess = (procReturnCode === '00');

    if(!isSuccess) {
        console.log(`[DEBUG] Transaction Declined. Code: ${procReturnCode}, Msg: ${postBody.mderrormessage || postBody.errmsg}`);
    }

    return isSuccess;
}