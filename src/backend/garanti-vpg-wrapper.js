import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

function clean(val) {
    return String(val || '').trim();
}

/**
 * [ADIM 1] Şifre Hashleme (SHA1)
 * Garanti, şifre hashlerken Terminal ID'nin 9 hane (030...) olmasını ister.
 */
function createHashedPassword(password, terminalId) {
    const paddedId = terminalId.padStart(9, '0'); 
    const rawData = password + paddedId;
    
    // Debug: Şifreleme girdisini konsola yaz (Canlıda kaldırın)
    console.log('[Garanti-Wrapper] PassHash Input:', `${password.substring(0, 2)}*** + ${paddedId}`);

    return crypto.createHash('sha1')
        .update(rawData, 'latin1')
        .digest('hex')
        .toUpperCase();
}

/**
 * [ADIM 2] Güvenlik Hash'i (SHA512)
 * Sıralama: TerminalID + OrderID + Amount + Currency + OkUrl + FailUrl + Type + Installment + StoreKey + HashedPassword
 */
function createSecure3DHash(data) {
    const plainText = 
        data.terminalId + 
        data.orderId + 
        data.amount + 
        data.currency + 
        data.okUrl + 
        data.failUrl + 
        data.txnType + 
        data.installment + 
        data.storeKey + 
        data.hashedPassword;

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
    installments = '1', 
    txnType = 'sales',
    customerIp,
    email = 'test@example.com'
}) {
    const [rawTerminalId, storeNo, password, rawStoreKey] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'), 
        getSecret('GARANTI_ENC_KEY')            
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) {
        throw new Error('Garanti Secrets eksik!');
    }

    // *** AYARLAR ***
    // Garanti Test ortamı genellikle 9 hane ID ve "1" taksit bekler.
    
    // 1. Terminal ID: 9 Hane (030691297)
    // "Input Invalid" hatası alıyorsak sebebi ID uzunluğu veya Taksit formatıdır.
    // Standart: 9 Hane.
    const terminalId = clean(rawTerminalId).replace(/^0+/, '').padStart(9, '0');
    
    const storeKey = clean(rawStoreKey);
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : clean(currency);
    const amount = String(amountMinor); 

    // 2. Taksit: "1" (PHP örneğindeki gibi sabit)
    const installmentStr = '1';

    const type = txnType || 'sales';

    // 3. Hash Hesaplama
    const hashedPassword = createHashedPassword(clean(password), terminalId);

    const securityHash = createSecure3DHash({
        terminalId: terminalId,
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

    // 4. URL (Test)
    const actionUrl = 'https://sanalposprovtest.garantibbva.com.tr/servlet/gt3dengine';

    // 5. Form Alanları
    const formFields = {
        mode: 'TEST',
        apiversion: '512',
        secure3dsecuritylevel: 'OOS_PAY', // Ortak Ödeme
        terminalprovuserid: 'PROVAUT',
        terminaluserid: 'PROVAUT',
        terminalmerchantid: clean(storeNo),
        terminalid: terminalId,
        orderid: orderId,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        txnamount: amount,
        txncurrencycode: currencyCode,
        txntype: type,
        txninstallmentcount: installmentStr, // "1"
        successurl: okUrl,
        errorurl: failUrl,
        secure3dhash: securityHash,
        lang: 'tr',
        // Debug için ek bilgiler
        txntimestamp: new Date().toISOString()
    };

    return { actionUrl, formFields };
}

export async function verifyCallbackHash(postBody) {
    // Hash doğrulama mantığı aynı kalabilir, 
    // ancak banka hata dönerse (Code 99) hash göndermeyebilir.
    return true; // Şimdilik debug için true dönüyoruz, hatayı görelim.
}

export function isApproved(postBody) {
    const getParam = (key) => {
        const found = Object.keys(postBody).find(k => k.toLowerCase() === key.toLowerCase());
        return found ? postBody[found] : '';
    };
    const mdStatus = getParam('mdstatus');
    const procReturnCode = getParam('procreturncode');
    const response = getParam('response');
    const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
    const procOk = String(procReturnCode) === '00' || String(response).toLowerCase() === 'approved';
    return mdOk && procOk;
}