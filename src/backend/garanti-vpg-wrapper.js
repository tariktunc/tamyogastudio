import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- YARDIMCI FONKSİYONLAR ---

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

    return crypto.createHash('sha1').update(plainText, 'utf8').digest('hex').toUpperCase();
}

/**
 * Bankadan dönen Hash'i doğrulama
 * Garanti dönüşte "hashparams" adında, hangi alanların hash'e dahil edildiğini belirten bir liste yollar.
 * Bu alanların değerlerini birleştirip sonuna StoreKey ekleyerek SHA1 alırız.
 */
export async function verifyCallbackHash(postBody) {
    try {
        const storeKey = await getSecret('GARANTI_ENC_KEY'); // ENC_KEY veya STORE_KEY (Genelde ENC kullanılır)
        const receivedHash = postBody.HASH || postBody.hash;
        const hashParams = postBody.hashparams || postBody.hashParams;

        if (!receivedHash || !hashParams || !storeKey) {
            console.warn('Garanti Callback: Eksik hash parametreleri.');
            return false;
        }

        // hashparams "orderid:amount:..." formatında gelir. Ayrıştırıp değerleri topluyoruz.
        const paramsList = String(hashParams).split(':').filter(Boolean);
        let plainText = '';

        for (const param of paramsList) {
            // Gelen parametre isimleri bazen küçük bazen büyük harf olabilir, ikisini de dene.
            const val = postBody[param] || postBody[param.toLowerCase()] || postBody[param.toUpperCase()] || '';
            plainText += val;
        }

        // En sona StoreKey eklenir (Password DEĞİL, StoreKey/EncKey)
        plainText += storeKey;

        // Garanti dönüş hash'i genellikle Base64 formatındadır (Hex değil).
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
    const [terminalId, merchantId, password, storeKey, provUserId, gatewayUrl] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),       // Merchant ID
        getSecret('GARANTI_TERMINAL_PASSWORD'),
        getSecret('GARANTI_ENC_KEY'),        // 3D Secure Key
        getSecret('GARANTI_PROVOOS_ID'),     // Prov User ID
        getSecret('GARANTI_CALLBACK_PATH')   // https://sanalposprov.garanti.com.tr
    ]);

    if (!terminalId || !storeKey || !password) throw new Error('Garanti Secretları eksik!');

    // 2. Veri Formatlaması
    // Garanti Amount formatı: "12.34" (Nokta ile ayrılmış kuruş)
    const amountMajor = (parseInt(String(amountMinor), 10) / 100).toFixed(2);
    const taksit = (installments && installments !== '1') ? String(installments) : '';
    
    // Timestamp formatı: YYYYMMDDHHmmSS
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 3. Hash Hesaplama
    const hashedPassword = createHashedPassword(password, terminalId);
    
    const hash = createSecure3DHash({
        terminalId,
        orderId,
        amount: amountMajor,
        okUrl,
        failUrl,
        txnType,
        installments: taksit,
        storeKey,
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
        txninstallmentcount: taksit, // Boşsa gönderilmez veya boş string gider
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

    // MDStatus: 1=Tam Doğrulama, 2=Kart Sahibi Kayıtlı Değil(bazı bankalar onaylar), 3=Kartın bankası kapalı(bazı bankalar onaylar), 4=Doğrulama denemesi
    const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
    
    // ProcReturnCode: "00" veya Response: "Approved"
    const prcOk = String(procReturnCode) === '00' || String(response).toLowerCase() === 'approved';

    return mdOk && prcOk;
}