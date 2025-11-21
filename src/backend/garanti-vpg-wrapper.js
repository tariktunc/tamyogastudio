import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- YARDIMCI FONKSİYONLAR ---

function cleanStr(str) {
    return String(str || '').trim();
}

// [ADIM 1] ŞİFRE HASHLEME (SHA1)
// Doküman Kaynağı (PHP): str_pad((int)$terminalId, 9, 0, STR_PAD_LEFT)
// Doküman Kaynağı (C#): provisionPassword + "0" + terminalId
function createHashedPassword(password, terminalId) {
    // Terminal ID, şifre ile birleşirken 9 haneye tamamlanır (Başına 0 eklenir)
    const terminalIdPadded = String(terminalId).trim().padStart(9, '0');
    const plain = password + terminalIdPadded;
    
    console.warn(`[DEBUG] HashedPass Input: ${password.substring(0,2)}*** + ${terminalIdPadded}`);

    return crypto.createHash('sha1')
        .update(plain, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// [ADIM 2] ANA HASH OLUŞTURMA (SHA512)
// Doküman Kaynağı (PHP): hash('sha512', $terminalId . $orderId ... )
function createSecure3DHash({ terminalId, orderId, amount, currency, okUrl, failUrl, typeForHash, installForHash, storeKey, hashedPassword }) {
    const plainText = 
        terminalId +      // DİKKAT: Burası 8 haneli (orijinal) hali olacak
        orderId +
        amount +
        currency +
        okUrl +
        failUrl +
        typeForHash +     // PHP örneğine göre boş ""
        installForHash +  // PHP örneğine göre "0"
        storeKey +
        hashedPassword;

    console.warn('------------------------------------------------');
    console.warn('[DEBUG] HASH STRING (Doküman Tam Uyumlu):');
    console.warn(plainText);
    console.warn('------------------------------------------------');

    return crypto.createHash('sha512')
        .update(plainText, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// =========================================================
// FORM OLUŞTURMA FONKSİYONU
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
    // 1. Secret Anahtarları Çek
    const [rawTerminalId, merchantId, password, rawStoreKey, gatewayUrl] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),       // Örn: 30691297
        getSecret('GARANTI_STORE_NO'),          // Örn: 7000679
        getSecret('GARANTI_TERMINAL_PASSWORD'), // Örn: 123qweASD/
        getSecret('GARANTI_ENC_KEY'),           // Örn: 12345678
        getSecret('GARANTI_CALLBACK_PATH')      // https://sanalposprovtest.garantibbva.com.tr
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) throw new Error('Garanti Secrets missing!');

    const terminalIdRaw = cleanStr(rawTerminalId); // 8 Haneli
    const passwordClean = cleanStr(password);
    const storeKeyClean = cleanStr(rawStoreKey);
    
    // 2. Tutar Formatı: "100" veya "45350.00" (PHP örneğinde "100" tam sayı verilmiş ama VPG genelde noktalı ister)
    // Biz Wix'ten gelen kuruşu (4535000) -> 45350.00 formatına çevirelim.
    const amountNum = Number(amountMinor) / 100;
    const amountClean = amountNum.toFixed(2); 

    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);

    // --- DOKÜMANA GÖRE HİBRİT AYARLAR ---

    // A. TAKSİT MANTIĞI
    // Form (HTML): Boş "" (HTML kuralı gereği)
    // Hash (PHP): "0" (PHP örneği gereği $installmentCount = 0)
    let installForForm = '';
    let installForHash = '0';
    
    if (installments && installments !== '0' && installments !== '1') {
        installForForm = String(installments);
        installForHash = String(installments);
    }

    // B. İŞLEM TİPİ MANTIĞI
    // Form (HTML): "sales" (HTML kuralı gereği)
    // Hash (PHP): "" (PHP örneği gereği $type = "")
    const typeForForm = txnType || 'sales';
    const typeForHash = ''; 

    // Zaman Damgası
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 3. Hash Hesaplama
    // Adım 1: Şifreyi Hashle (Terminal ID 9 hane olur)
    const hashedPassword = createHashedPassword(passwordClean, terminalIdRaw);

    // Adım 2: Ana Hash'i Oluştur (Terminal ID 8 hane kalır)
    const hash = createSecure3DHash({
        terminalId: terminalIdRaw,
        orderId,
        amount: amountClean,
        currency: currencyCode,
        okUrl,
        failUrl,
        typeForHash: typeForHash,       // "" (Boş)
        installForHash: installForHash, // "0" (Peşin ise)
        storeKey: storeKeyClean,
        hashedPassword
    });

    // 4. URL Ayarı (VPServlet)
    const cleanBase = String(gatewayUrl || 'https://sanalposprovtest.garantibbva.com.tr').replace(/\/+$/, '');
    // Dokümanda belirtilen path: VPServlet
    let actionUrl = cleanBase.endsWith('VPServlet') ? cleanBase : `${cleanBase}/VPServlet`;
    
    // Eğer secret'ta sadece base url (garantibbva.com.tr) varsa sonuna ekle
    if (!actionUrl.includes('VPServlet')) {
         // Eski gt3dengine varsa değiştir, yoksa ekle
         if (cleanBase.includes('gt3dengine')) {
             actionUrl = cleanBase.replace('servlet/gt3dengine', 'VPServlet');
         } else {
             actionUrl = `${cleanBase}/VPServlet`;
         }
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
        txnamount: amountClean,
        txncurrencycode: currencyCode,
        txntype: typeForForm,           // Form'a "sales"
        txninstallmentcount: installForForm, // Form'a ""
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