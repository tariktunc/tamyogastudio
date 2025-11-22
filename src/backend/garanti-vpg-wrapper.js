import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

function clean(val) {
    return String(val || '').trim();
}

/**
 * [ADIM 1] Şifre Hashleme (SHA1)
 * KRİTİK: Banka arka planda şifreyi doğrularken Terminal ID'nin 
 * başına 0 eklenmiş (9 haneli) halini kullanır.
 */
function createHashedPassword(password, terminalId) {
    // Terminal ID'yi 9 haneye tamamla (Örn: 30691297 -> 030691297)
    const paddedId = terminalId.padStart(9, '0'); 
    const rawData = password + paddedId;
    
    console.log('[Garanti-Wrapper] Password Hash Input:', `${password.substring(0, 2)}*** + ${paddedId}`);

    return crypto.createHash('sha1')
        .update(rawData, 'latin1')
        .digest('hex')
        .toUpperCase();
}

/**
 * [ADIM 2] Güvenlik Hash'i (SHA512)
 * KRİTİK: Buradaki Terminal ID, formda gönderilen (8 haneli) ile AYNI olmalıdır.
 * Yoksa "Hash Hatası" alırsınız.
 */
function createSecure3DHash(data) {
    const plainText = 
        data.terminalId + // Formdaki ID (8 hane)
        data.orderId + 
        data.amount + 
        data.currency + 
        data.okUrl + 
        data.failUrl + 
        data.txnType + 
        data.installment + 
        data.storeKey + 
        data.hashedPassword; // 9 haneli ID ile üretilmiş şifre hash'i

    console.log('[Garanti-Wrapper] Main Hash Input:', plainText);

    return crypto.createHash('sha512')
        .update(plainText, 'latin1')
        .digest('hex')
        .toUpperCase();
}

export async function buildPayHostingForm({
    orderId,
    amountMinor, 
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
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'), 
        getSecret('GARANTI_ENC_KEY')            
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) {
        throw new Error('Garanti Secrets eksik!');
    }

    // 2. Veri Hazırlığı
    // Terminal ID'yi Secrets'tan geldiği gibi (varsa başındaki 0'ları temizleyerek) alıyoruz.
    // Örn: "30691297" (8 hane) -> Form'da bu gidecek.
    const terminalIdRaw = clean(rawTerminalId).replace(/^0+/, '');
    
    const storeKey = clean(rawStoreKey);
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : clean(currency);
    const amount = String(amountMinor); // Kuruş cinsinden (100 = 1.00 TL)

    // Taksit: Test ortamı boş taksiti sevmez, peşin için "1" gönderiyoruz.
    let installmentStr = String(installments || '1');
    if (installmentStr === '0' || installmentStr === '') installmentStr = '1';

    const type = txnType || 'sales';

    // 3. Hash Hesaplama
    // A. Şifre Hash: Padded ID (030691297) kullanır.
    const hashedPassword = createHashedPassword(clean(password), terminalIdRaw);

    // B. Ana Hash: Raw ID (30691297) kullanır.
    const securityHash = createSecure3DHash({
        terminalId: terminalIdRaw, // 8 Hane
        orderId: orderId,
        amount: amount,
        currency: currencyCode,
        okUrl: okUrl,
        failUrl: failUrl,
        txnType: type,
        installment: installmentStr,
        storeKey: storeKey,
        hashedPassword: hashedPassword
    });

    // 4. Banka URL (Test)
    const actionUrl = 'https://sanalposprovtest.garantibbva.com.tr/servlet/gt3dengine';

    // 5. Form Alanları
    // "OOS_PAY" -> Ortak Ödeme Sayfası (Kart bilgisi istemez, bankaya yönlendirir)
    const formFields = {
            mode: 'TEST',
            apiversion: '512',
            secure3dsecuritylevel: 'OOS_PAY',
            terminalprovuserid: 'PROVAUT',
            terminaluserid: 'PROVAUT',
            terminalmerchantid: '7000679',
            terminalid: '30691297',
            orderid: 'TESTORDER12345',
            customeripaddress: '127.0.0.1',
            customeremailaddress: 'test@example.com',
            txnamount: '100',
            txncurrencycode: '949',
            txntype: 'sales',
            txninstallmentcount: '',
            successurl: 'https://www.ornekdomain.com/success',
            errorurl: 'https://www.ornekdomain.com/fail',
            secure3dhash: securityHash,
            lang: 'tr',
            refreshtime: '10',
            txntimestamp: new Date().toISOString()
    };

    return { actionUrl, formFields };
}

/**
 * Callback Hash Doğrulama
 */
export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const storeKey = clean(rawStoreKey);

        const getParam = (key) => {
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === key.toLowerCase());
            return foundKey ? postBody[foundKey] : null;
        };

        const responseHash = getParam('hash') || getParam('secure3dhash');
        const hashParams = getParam('hashparams');

        if (!responseHash || !hashParams) {
            return false;
        }

        const paramList = String(hashParams).split(':');
        let digestData = '';
        
        for (const param of paramList) {
            if (!param) continue;
            const val = getParam(param);
            if (val !== null && val !== undefined) {
                digestData += val;
            }
        }
        
        digestData += storeKey;

        const calculatedHash = crypto.createHash('sha512')
            .update(digestData, 'latin1')
            .digest('hex')
            .toUpperCase();

        return (responseHash.toUpperCase() === calculatedHash);

    } catch (e) {
        console.error('Verify Error:', e);
        return false;
    }
}

export function isApproved(postBody) {
    const getParam = (key) => {
        const found = Object.keys(postBody).find(k => k.toLowerCase() === key.toLowerCase());
        return found ? postBody[found] : '';
    };

    const mdStatus = getParam('mdstatus');
    const procReturnCode = getParam('procreturncode');
    const response = getParam('response');

    // OOS modelinde MDStatus dönüşü başarılı işlemler için genelde 1'dir.
    const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
    const procOk = String(procReturnCode) === '00' || String(response).toLowerCase() === 'approved';

    return mdOk && procOk;
}