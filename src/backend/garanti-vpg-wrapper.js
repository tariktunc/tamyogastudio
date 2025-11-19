import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- YARDIMCI FONKSİYONLAR ---

/**
 * Store Key Normalizasyonu (HEX Desteği)
 * Eğer secret olarak girilen anahtar HEX formatındaysa (örn: "414243..."),
 * bunu hashlemeden önce UTF-8 string'e çevirir.
 */
function normalizeStoreKey(key) {
    const trimmedKey = String(key || '').trim();
    
    // Regex: Sadece 0-9, A-F karakterlerinden oluşuyorsa ve çift sayı uzunluğundaysa HEX kabul et
    const isHex = /^[0-9A-Fa-f]+$/.test(trimmedKey) && (trimmedKey.length % 2 === 0);
    
    if (isHex) {
        try {
            // HEX string -> Buffer -> UTF8 String
            return Buffer.from(trimmedKey, 'hex').toString('utf8');
        } catch (e) {
            console.warn('Garanti Wrapper: Store Key Hex decode hatası, ham değer kullanılıyor:', e);
            return trimmedKey;
        }
    }
    // Hex değilse olduğu gibi (Plain Text) döndür
    return trimmedKey;
}

/**
 * Garanti'ye özel Terminal Şifresi Hashleme
 * Kural: SHA1(Password + TerminalID(9 hane, sol tarafı 0 dolgulu)) -> UpperCase
 */
function createHashedPassword(password, terminalId) {
    const terminalIdPadded = String(terminalId).padStart(9, '0');
    const plain = password + terminalIdPadded;
    return crypto.createHash('sha1').update(plain, 'utf8').digest('hex').toUpperCase();
}

/**
 * İstek Hash'i Oluşturma (Security Level: 3D_OOS_FULL)
 * Sıralama çok kritiktir:
 * TerminalID + OrderID + Amount + OkUrl + FailUrl + Type + Installment + StoreKey + HashedPassword
 */
function createSecure3DHash({ terminalId, orderId, amount, okUrl, failUrl, txnType, installments, storeKey, hashedPassword }) {
    // 1. Store Key'i kontrol et ve gerekirse decode et (Hex -> String)
    const decodedStoreKey = normalizeStoreKey(storeKey);

    const plainText = 
        terminalId +
        orderId +
        amount +
        okUrl +
        failUrl +
        txnType +
        installments +
        decodedStoreKey + 
        hashedPassword;

    return crypto.createHash('sha1').update(plainText, 'utf8').digest('hex').toUpperCase();
}

/**
 * Bankadan dönen Hash'i doğrulama
 * Garanti dönüşte "hashparams" adında, hangi alanların hash'e dahil edildiğini belirten bir liste yollar.
 * Bu alanların değerlerini birleştirip sonuna StoreKey ekleyerek SHA1 alırız.
 */
export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY'); // ENC_KEY veya STORE_KEY
        const receivedHash = postBody.HASH || postBody.hash;
        const hashParams = postBody.hashparams || postBody.hashParams;

        if (!receivedHash || !hashParams || !rawStoreKey) {
            console.warn('Garanti Callback: Eksik hash parametreleri veya Secret bulunamadı.');
            return false;
        }

        // 1. Store Key'i normalize et (Hex -> String)
        const storeKey = normalizeStoreKey(rawStoreKey);

        // 2. hashparams "orderid:amount:..." formatında gelir. Ayrıştırıp değerleri topluyoruz.
        const paramsList = String(hashParams).split(':').filter(Boolean);
        let plainText = '';

        for (const param of paramsList) {
            // Gelen parametre isimleri case-insensitive eşleştirilmelidir.
            // postBody içindeki anahtarı bulmaya çalışıyoruz.
            const keyLower = param.toLowerCase();
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === keyLower);
            
            const val = foundKey ? postBody[foundKey] : '';
            plainText += val;
        }

        // 3. En sona Decode Edilmiş StoreKey eklenir (Password DEĞİL)
        plainText += storeKey;

        // Garanti dönüş hash'i genellikle Base64 formatındadır.
        const calculatedHash = crypto.createHash('sha1').update(plainText, 'utf8').digest('base64');

        return receivedHash === calculatedHash;
    } catch (e) {
        console.error('Garanti Verify Error:', e);
        return false;
    }
}

// --- ANA FONKSİYON ---

export async function buildPayHostingForm({
  orderId,
  amountMinor,
  currency = '949', // TRY
  okUrl,
  failUrl,
  installments = '', // Taksit yoksa boş string olmalı
  txnType = 'sales', // Garanti için genelde 'sales'
  customerIp,
  email = 'musteri@example.com' // Opsiyonel
}) {
    // 1. Secret'ları güvenli şekilde çek
    const [terminalId, merchantId, password, rawStoreKey, provUserId, gatewayUrl] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),       // Merchant ID
        getSecret('GARANTI_TERMINAL_PASSWORD'),
        getSecret('GARANTI_ENC_KEY'),        // 3D Secure Key (Hex olabilir)
        getSecret('GARANTI_PROVOOS_ID'),     // Prov User ID
        getSecret('GARANTI_CALLBACK_PATH')   // https://sanalposprov.garanti.com.tr
    ]);

    if (!terminalId || !rawStoreKey || !password) throw new Error('Garanti Secretları eksik!');

    // 2. Veri Formatlaması
    // Garanti Amount formatı: "12.34" (Nokta ile ayrılmış kuruş)
    const amountMajor = (parseInt(String(amountMinor), 10) / 100).toFixed(2);
    
    // Taksit boşsa veya 1 ise boş string gönderilir (Sales işlemi için)
    const taksit = (installments && installments !== '1' && installments !== '0') ? String(installments) : '';
    
    // Timestamp formatı: YYYYMMDDHHmmSS
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 3. Hash Hesaplama
    const hashedPassword = createHashedPassword(password, terminalId);
    
    // Not: rawStoreKey'i gönderiyoruz, fonksiyon içinde normalize ediliyor.
    const hash = createSecure3DHash({
        terminalId,
        orderId,
        amount: amountMajor,
        okUrl,
        failUrl,
        txnType,
        installments: taksit,
        storeKey: rawStoreKey, 
        hashedPassword
    });

    // 4. Endpoint Belirleme
    // Ortak Ödeme Sayfası için standart path: /servlet/gt3dengine
    const cleanBase = String(gatewayUrl || 'https://sanalposprov.garanti.com.tr').replace(/\/+$/, '');
    const actionUrl = `${cleanBase}/servlet/gt3dengine`;

    // 5. Form Alanları (3D_OOS_FULL Modeli)
    const formFields = {
        mode: 'PROD',
        apiversion: 'v0.01',
        terminalprovuserid: provUserId,
        terminaluserid: provUserId, // Genelde prov ile aynıdır
        terminalmerchantid: merchantId,
        terminalid: terminalId,
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

/** İşlem Başarılı mı? */
export function isApproved(postBody) {
    const mdStatus = postBody.mdstatus || postBody.MDStatus;
    const procReturnCode = postBody.procreturncode || postBody.ProcReturnCode;
    const response = postBody.response || postBody.Response; // 'Approved' dönebilir

    // MDStatus: 1=Tam Doğrulama, 2=Kart Sahibi Kayıtlı Değil, 3=Kartın bankası kapalı, 4=Doğrulama denemesi
    const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
    
    // ProcReturnCode: "00" veya Response: "Approved"
    const prcOk = String(procReturnCode) === '00' || String(response).toLowerCase() === 'approved';

    return mdOk && prcOk;
}