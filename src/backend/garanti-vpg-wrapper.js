import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- HELPER: String Temizleme ---
function cleanStr(str) {
    return String(str || '').trim();
}

// --- HELPER: Password Hashing (SHA1) ---
// PHP Örneği: sha1($password . str_pad($terminalId, 9, 0, STR_PAD_LEFT)) -> Upper
function createHashedPassword(password, terminalId) {
    // Terminal ID her zaman 9 haneye tamamlanır (başına 0 eklenerek)
    const terminalIdEffective = String(terminalId).trim().padStart(9, '0');
    const plain = password + terminalIdEffective;
    
    console.log('[DEBUG] HashedPassword Plain:', plain);

    return crypto.createHash('sha1')
        .update(plain, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// --- HELPER: Main 3D Hash Construction (SHA512) ---
// PHP Sırası: TerminalID + OrderID + Amount + CurrencyCode + SuccessUrl + ErrorUrl + Type + InstallmentCount + StoreKey + HashedPassword
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
    console.log('[DEBUG] HASH STRING (SHA512) INPUT:');
    console.log(plainText);
    console.log('------------------------------------------------');

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
        const receivedHash = postBody.secure3dhash || postBody.hash || postBody.HASH; 
        const hashParams = postBody.hashparams || postBody.hashParams;

        if (!receivedHash || !rawStoreKey) {
            console.warn('[DEBUG] Callback Verify: Missing hash or store key.');
            return false;
        }

        const storeKey = cleanStr(rawStoreKey);
        let paramsList = [];

        if (hashParams) {
            paramsList = String(hashParams).split(':').filter(Boolean);
        } else {
            // Garanti standart parametre sırası (HashParams gelmezse)
            paramsList = [
                'clientid', 'oid', 'authcode', 'procreturncode', 'mdstatus',
                'txnamount', 'txncurrencycode', 'txntimestamp'
            ];
        }

        let plainText = '';
        for (const param of paramsList) {
            const keyLower = param.toLowerCase();
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === keyLower);
            const val = foundKey ? postBody[foundKey] : '';
            plainText += val;
        }

        plainText += storeKey;

        const calculatedHash = crypto.createHash('sha512')
            .update(plainText, 'utf8')
            .digest('hex')
            .toUpperCase();

        const calculatedHashBase64 = crypto.createHash('sha512')
            .update(plainText, 'utf8')
            .digest('base64');

        const isValid = (receivedHash === calculatedHash) || (receivedHash === calculatedHashBase64);

        if (!isValid) {
             console.log(`[DEBUG] Hash Fail. Calc: ${calculatedHash}, Recv: ${receivedHash}`);
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
        getSecret('GARANTI_CALLBACK_PATH')
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) throw new Error('Garanti Secrets missing!');

    // Değerleri temizle (Boşlukları sil)
    const terminalIdClean = cleanStr(rawTerminalId);
    const passwordClean = cleanStr(password);
    const storeKeyClean = cleanStr(rawStoreKey);
    
    // Terminal ID her zaman 9 haneli olmalıdır (Hash hesaplarken ve gönderirken)
    const terminalIdToSend = terminalIdClean.padStart(9, '0');

    // Amount: "100.00" formatına çevir
    const amountNum = Number(amountMinor) / 100;
    const amountClean = amountNum.toFixed(2); 

    // Currency: Eğer "TRY" gelirse "949" yap, yoksa olduğu gibi kullan
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);

    // Taksit: Tek çekim için boş string mi yoksa "0" mı gönderileceği banka ayarına bağlıdır.
    // Genellikle boş string "Tek Çekim"dir. PHP örneğinde "0" var ama çoğu VPG boş bekler.
    // Standart olarak boş string gönderiyoruz. Eğer hata devam ederse burayı "0" yapabiliriz.
    const taksit = (installments && installments !== '1' && installments !== '0') ? String(installments) : '';

    // Transaction Type: Genellikle "sales"
    const typeStr = txnType || 'sales';

    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 1. Adım: Şifreyi Hashle
    const hashedPassword = createHashedPassword(passwordClean, terminalIdToSend);

    // 2. Adım: Ana Hash'i Oluştur (PHP'deki sırayla)
    const hash = createSecure3DHash({
        terminalId: terminalIdToSend,
        orderId,
        amount: amountClean,
        currency: currencyCode, // Düzeltildi: 949 gönderiliyor
        okUrl,
        failUrl,
        txnType: typeStr,
        installments: taksit,
        storeKey: storeKeyClean,
        hashedPassword
    });

    const cleanBase = String(gatewayUrl || 'https://sanalposprov.garanti.com.tr').replace(/\/+$/, '');
    const actionUrl = cleanBase.includes('gt3dengine') ? cleanBase : `${cleanBase}/servlet/gt3dengine`;

    // Bankaya Gönderilecek Form
    const formFields = {
        mode: 'PROD',
        apiversion: 'v0.01',
        terminalprovuserid: 'PROVOOS',
        terminaluserid: 'PROVOOS',
        terminalmerchantid: cleanStr(merchantId),
        terminalid: terminalIdToSend,
        orderid: orderId,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        txnamount: amountClean,
        txncurrencycode: currencyCode, // Hash içindekiyle AYNI olmalı
        txntype: typeStr,              // Hash içindekiyle AYNI olmalı
        txninstallmentcount: taksit,   // Hash içindekiyle AYNI olmalı
        successurl: okUrl,             // Hash içindekiyle AYNI olmalı
        errorurl: failUrl,             // Hash içindekiyle AYNI olmalı
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