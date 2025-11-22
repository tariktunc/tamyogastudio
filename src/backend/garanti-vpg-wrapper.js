import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

/**
 * Helper: Değerleri temiz stringe çevirir.
 */
function clean(val) {
    return val ? String(val).trim() : '';
}

/**
 * [ADIM 1] Garanti Şifre Hashleme (SHA1)
 * Kural: SHA1(TerminalPassword + PadLeft(TerminalID, 9, '0'))
 * Çıktı: Büyük harf HEX string
 */
function createHashedPassword(password, terminalId) {
    // Terminal ID mutlaka 9 hane olmalı (Başına 0 eklenerek)
    const paddedTerminalId = terminalId.padStart(9, '0');
    
    // Şifre + PaddedID birleşimi
    const rawData = password + paddedTerminalId;

    // Debug için log (Canlıda kaldırabilirsiniz)
    console.log('[Garanti-Wrapper] HashedPassword Input:', `${password.substring(0, 2)}*** + ${paddedTerminalId}`);

    // SHA1 hash üretimi (Latin1 encoding Garanti için kritiktir)
    return crypto.createHash('sha1')
        .update(rawData, 'latin1')
        .digest('hex')
        .toUpperCase();
}

/**
 * [ADIM 2] Güvenlik Hash'i Oluşturma (SHA512)
 * Kural: TerminalID + OrderID + Amount + Currency + OkUrl + FailUrl + Type + Installment + StoreKey + HashedPassword
 * Çıktı: Büyük harf HEX string
 */
function createSecure3DHash(data) {
    const {
        terminalId, orderId, amount, currency, 
        okUrl, failUrl, txnType, installment, 
        storeKey, hashedPassword
    } = data;

    // Sıralama çok önemlidir, banka bu sırayı bekler:
    const plainText = 
        terminalId + 
        orderId + 
        amount + 
        currency + 
        okUrl + 
        failUrl + 
        txnType + 
        installment + 
        storeKey + 
        hashedPassword;

    console.log('[Garanti-Wrapper] Hash String:', plainText);

    return crypto.createHash('sha512')
        .update(plainText, 'latin1')
        .digest('hex')
        .toUpperCase();
}

/**
 * Form Oluşturucu Fonksiyon
 */
export async function buildPayHostingForm({
    orderId,
    amountMinor, // Wix'ten "100" (1.00 TL) veya "1250" (12.50 TL) olarak gelir.
    currency = '949',
    okUrl,
    failUrl,
    installments = '',
    txnType = 'sales',
    customerIp,
    email = 'test@example.com'
}) {
    // 1. Secret'ları Çek
    const [rawTerminalId, storeNo, password, rawStoreKey] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),       // Örn: 30691297
        getSecret('GARANTI_STORE_NO'),          // Örn: 1001
        getSecret('GARANTI_TERMINAL_PASSWORD'), // Örn: 12345678
        getSecret('GARANTI_ENC_KEY')            // Örn: 12345678
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) {
        throw new Error('Garanti Secrets (TerminalID, Password veya StoreKey) eksik!');
    }

    // 2. Verileri Formatla
    // Terminal ID: Başındaki sıfırları temizleyip tekrar 9 haneye tamamlıyoruz (Garanti standardı)
    const terminalId = clean(rawTerminalId).replace(/^0+/, '').padStart(9, '0');
    const storeKey = clean(rawStoreKey);
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : clean(currency);
    
    // Tutar: Garanti VPG, kuruş cinsinden (noktasız) ister. Wix zaten böyle gönderir.
    // Örn: 1.00 TL -> "100"
    const amount = String(amountMinor);

    // Taksit: Peşin ise boş string, taksit ise sayı stringi (örn: "3")
    let installmentStr = '';
    if (installments && installments !== '0' && installments !== '1') {
        installmentStr = String(installments);
    }

    // İşlem Tipi: Genelde "sales"
    const type = txnType || 'sales';

    // 3. Hash Hesaplamaları
    // A. Şifreyi Hashle
    const hashedPassword = createHashedPassword(clean(password), terminalId);

    // B. Ana Hash'i Oluştur
    const securityHash = createSecure3DHash({
        terminalId,
        orderId,
        amount,
        currency: currencyCode,
        okUrl,
        failUrl,
        txnType: type,
        installment: installmentStr,
        storeKey,
        hashedPassword
    });

    // 4. Test Ortamı URL'si (Birebir bankanın test URL'si)
    const actionUrl = 'https://sanalposprovtest.garantibbva.com.tr/servlet/gt3dengine';

    // 5. Form Alanları (Banka dökümanındaki isimlerle birebir)
    const formFields = {
        mode: 'TEST',               // Test ortamı için zorunlu
        apiversion: '512',          // Standart versiyon
        secure3dsecuritylevel: 'OOS_PAY', // 3D Hosting Modeli
        
        // Test ortamı için "PROVAUT" kullanıcıları standarttır
        terminalprovuserid: 'PROVAUT',
        terminaluserid: 'PROVAUT',
        
        terminalmerchantid: clean(storeNo),
        terminalid: terminalId,     // 9 Haneli (030xxxxxx)
        orderid: orderId,
        
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        
        txnamount: amount,          // "100" formatında
        txncurrencycode: currencyCode,
        txntype: type,              // "sales"
        txninstallmentcount: installmentStr, // Peşin ise boş
        
        successurl: okUrl,
        errorurl: failUrl,
        
        // Garanti için güvenlik hash'i
        secure3dhash: securityHash,
        
        // İsteğe bağlı ama iyi olur
        lang: 'tr',
        refreshtime: '10',
        txntimestamp: new Date().toISOString() // Log amaçlı
    };

    console.log('[Garanti-Wrapper] Form Hazırlandı. Hedef:', actionUrl);
    return { actionUrl, formFields };
}

/**
 * Callback Hash Doğrulama
 * Bankadan gelen yanıtın doğruluğunu kontrol eder.
 */
export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const storeKey = clean(rawStoreKey);

        // Gelen parametreleri normalize et (Büyük/küçük harf duyarlılığı olmasın)
        const getParam = (key) => {
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === key.toLowerCase());
            return foundKey ? postBody[foundKey] : '';
        };

        const responseHash = getParam('hash') || getParam('secure3dhash');
        const hashParams = getParam('hashparams');

        if (!responseHash || !hashParams) {
            console.warn('[Garanti-Wrapper] Hash parametreleri eksik.');
            return false;
        }

        // Bankanın söylediği parametreleri sırasıyla birleştir
        const paramList = String(hashParams).split(':');
        let digestData = '';
        
        for (const param of paramList) {
            if (!param) continue;
            // Banka bazen parametre adını, bazen değerini hashparams içinde gönderebilir
            // Genelde hashparams "orderid:txnamount:..." gibi parametre isimlerini içerir.
            const val = getParam(param);
            // Eğer parametre null ise hash'e eklenmez
            if (val !== null && val !== undefined) {
                digestData += val;
            }
        }
        
        // En sona StoreKey eklenir
        digestData += storeKey;

        // Hash hesapla
        const calculatedHash = crypto.createHash('sha512')
            .update(digestData, 'latin1') // Encoding'e dikkat
            .digest('hex')
            .toUpperCase();

        const isValid = (responseHash.toUpperCase() === calculatedHash);
        
        if (!isValid) {
            console.warn('[Garanti-Wrapper] Hash Uyuşmazlığı!', {
                gelen: responseHash,
                hesaplanan: calculatedHash,
                string: digestData
            });
        }

        return isValid;

    } catch (e) {
        console.error('[Garanti-Wrapper] Verify Hatası:', e);
        return false;
    }
}

/**
 * İşlem Başarılı mı?
 */
export function isApproved(postBody) {
    const getParam = (key) => {
        const found = Object.keys(postBody).find(k => k.toLowerCase() === key.toLowerCase());
        return found ? postBody[found] : '';
    };

    const mdStatus = getParam('mdstatus');
    const procReturnCode = getParam('procreturncode');
    const response = getParam('response');

    // MDStatus: 1=Tam Doğrulama, 2,3,4=Kart durumu özel durumlar (kabul edilebilir)
    // 0, 5, 6, 7, 8, 9 = Hata
    const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
    
    // ProcReturnCode: 00 = Onaylandı
    const procOk = String(procReturnCode) === '00' || String(response).toLowerCase() === 'approved';

    return mdOk && procOk;
}