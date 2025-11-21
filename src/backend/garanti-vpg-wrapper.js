import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- YARDIMCI: String Temizleme ---
function cleanStr(str) {
    return String(str || '').trim();
}

// --- YARDIMCI: Password Hashing (SHA1) ---
// PHP: sha1($password . str_pad($terminalId, 9, 0, STR_PAD_LEFT)) -> Upper
function createHashedPassword(password, terminalId) {
    const terminalIdEffective = String(terminalId).trim().padStart(9, '0');
    const plain = password + terminalIdEffective;
    
    // Gizlilik için şifrenin tamamını loglamıyoruz, sadece formatı kontrol ediyoruz
    console.log('[DEBUG] HashedPassword Generated for Terminal:', terminalIdEffective);

    return crypto.createHash('sha1')
        .update(plain, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// --- YARDIMCI: GÖNDERİM İÇİN HASH (SHA512) ---
// PHP Sırası: TerminalID + OrderID + Amount + CurrencyCode + SuccessUrl + ErrorUrl + Type + Installment + StoreKey + HashedPassword
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
    console.log('[DEBUG] OUTGOING HASH STRING TO SIGN:');
    console.log(plainText);
    console.log('------------------------------------------------');

    return crypto.createHash('sha512')
        .update(plainText, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// =========================================================
// 1. BUILD PAY FORM (3D_OOS_FULL / PHP MANTIĞI)
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
    
    // 1. Terminal ID: 9 haneye tamamla (Başına 0 koy)
    const terminalIdToSend = terminalIdClean.padStart(9, '0');

    // 2. Amount: PHP örneğinde "100" string kullanılmıştı. Ancak VPG genelde "100.00" ister.
    // Güvenli yöntem: Wix'ten gelen kuruşlu tutarı (10000) -> "100.00" formatına çeviriyoruz.
    const amountNum = Number(amountMinor) / 100;
    const amountClean = amountNum.toFixed(2); 

    // 3. Currency: TRY gelirse "949" yap.
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);

    // 4. Taksit (KRİTİK DÜZELTME):
    // PHP örneğinde taksit "0" idi. HTML formunda "" idi.
    // Hash hatasını çözmek için Peşin işlemde taksit sayısını "0" string olarak sabitliyoruz.
    // Eğer installments değeri yoksa veya 1 ise "0" gönderiyoruz.
    let taksit = (installments && installments !== '1' && installments !== '0') ? String(installments) : '0';

    // 5. İşlem Tipi
    const typeStr = txnType || 'sales';

    // 6. Zaman Damgası (Format: YYYYMMDDHHmmss)
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 7. Hashed Password (SHA1)
    const hashedPassword = createHashedPassword(passwordClean, terminalIdToSend);

    // 8. Main Hash (SHA512)
    const hash = createSecure3DHash({
        terminalId: terminalIdToSend,
        orderId,
        amount: amountClean,
        currency: currencyCode,
        okUrl,
        failUrl,
        txnType: typeStr,
        installments: taksit, // Burası artık "0" gidiyor
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
        txninstallmentcount: taksit, // Form'da da "0" yazacak
        successurl: okUrl,
        errorurl: failUrl,
        txntimestamp: timestamp,
        secure3dhash: hash,
        lang: 'tr'
    };

    return { actionUrl, formFields };
}

// =========================================================
// 2. CALLBACK VERIFICATION (DÖNÜŞ KONTROLÜ - DİNAMİK)
// =========================================================

export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const storeKey = cleanStr(rawStoreKey);

        // Gelen veriler
        const responseHash = postBody.hash || postBody.HASH || postBody.secure3dhash;
        const hashParams = postBody.hashparams || postBody.hashParams || postBody.HASHPARAMS;

        // Eğer banka hata dönerse (MD:7 gibi) hashparams gelmez. Bu yüzden önce bunu kontrol ediyoruz.
        if (!responseHash || !hashParams) {
            // Bu bir hata değil, bankanın reddetme durumudur.
            console.warn('[DEBUG] Callback: Hash or HashParams missing. Transaction likely rejected by bank.');
            return false;
        }

        // Parametreleri ayır: clientid:oid:authcode...
        const paramList = String(hashParams).split(':');
        
        let digestData = '';

        for (const param of paramList) {
            if(!param) continue;
            const keyLower = param.toLowerCase();
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === keyLower);
            const value = foundKey ? postBody[foundKey] : '';
            digestData += value;
        }

        // Store Key ekle
        digestData += storeKey;

        // SHA512 Hesapla
        const calculatedHash = crypto.createHash('sha512')
            .update(digestData, 'utf8')
            .digest('hex')
            .toUpperCase();

        const isValid = (responseHash === calculatedHash);

        if (isValid) {
            console.log('[DEBUG] HASH SUCCESS: Verified with Bank params.');
        } else {
            console.log(`[DEBUG] HASH FAIL: Calc: ${calculatedHash} vs Recv: ${responseHash}`);
        }

        return isValid;

    } catch (e) {
        console.error('[DEBUG] Verify Error:', e);
        return false;
    }
}

// =========================================================
// 3. ONAY KONTROLÜ
// =========================================================

export function isApproved(postBody) {
    const procReturnCode = String(postBody.procreturncode || postBody.ProcReturnCode || '');
    // Dokümana göre sadece "00" başarılıdır.
    return procReturnCode === '00';
}