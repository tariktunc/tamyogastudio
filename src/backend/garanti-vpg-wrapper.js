import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

function clean(val) {
    return String(val || '').trim();
}

/**
 * [ADIM 1] Şifre Hashleme (SHA1)
 * Terminal ID'nin bankadan geldiği formatta (genelde 9 hane) kullanılır.
 */
function createHashedPassword(password, terminalId) {
    // Terminal ID'yi 9 haneye tamamla (örn: 30691297 -> 030691297)
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
 * KRITIK: Terminal ID formdaki ile AYNI olmalı (genelde 9 hane).
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

    // 2. Terminal ID'yi olduğu gibi kullan (leading zero'ları KORUYARAK)
    const terminalId = clean(rawTerminalId);
    
    // Terminal ID 9 haneye tamamlanmalı (bankadan genelde 8-9 hane gelir)
    const terminalIdPadded = terminalId.padStart(9, '0');
    
    const storeKey = clean(rawStoreKey);
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : clean(currency);
    const amount = String(amountMinor);

    let installmentStr = String(installments || '1');
    if (installmentStr === '0' || installmentStr === '') installmentStr = '1';

    const type = txnType || 'sales';

    // 3. Hash Hesaplama
    // Her iki hash için de AYNI Terminal ID kullanılmalı
    const hashedPassword = createHashedPassword(clean(password), terminalIdPadded);
    
    const securityHash = createSecure3DHash({
        terminalId: terminalIdPadded, // 9 hane, padding ile
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

    console.log('[Garanti-Wrapper] Using Terminal ID:', terminalIdPadded);
    console.log('[Garanti-Wrapper] Order ID:', orderId);
    console.log('[Garanti-Wrapper] Amount (kuruş):', amount);

    // 4. Banka URL (Test)
    const actionUrl = 'https://sanalposprovtest.garantibbva.com.tr/servlet/gt3dengine';

    // 5. Form Alanları
    const formFields = {
        mode: 'TEST',
        apiversion: '512',
        secure3dsecuritylevel: 'OOS_PAY',
        terminalprovuserid: 'PROVAUT',
        terminaluserid: 'PROVAUT',
        terminalmerchantid: clean(storeNo),
        terminalid: terminalIdPadded, // 9 haneli ID gönder
        orderid: orderId,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        txnamount: amount,
        txncurrencycode: currencyCode,
        txntype: type,
        txninstallmentcount: installmentStr,
        successurl: okUrl,
        errorurl: failUrl,
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
            console.error('[Garanti-Wrapper] Hash verification failed: Missing hash or hashparams');
            return false;
        }

        const paramList = String(hashParams).split(':');
        let digestData = '';
        
        console.log('[Garanti-Wrapper] Hash params order:', hashParams);
        
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

        const isValid = (responseHash.toUpperCase() === calculatedHash);
        
        if (!isValid) {
            console.error('[Garanti-Wrapper] Hash mismatch!');
            console.error('Expected:', calculatedHash);
            console.error('Received:', responseHash.toUpperCase());
        } else {
            console.log('[Garanti-Wrapper] Hash verification successful');
        }

        return isValid;

    } catch (e) {
        console.error('[Garanti-Wrapper] Verify Error:', e);
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

    console.log('[Garanti-Wrapper] Approval check - MDStatus:', mdStatus, 'ProcReturnCode:', procReturnCode);

    // OOS modelinde MDStatus başarılı işlemler için genelde 1'dir
    const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
    const procOk = String(procReturnCode) === '00' || String(response).toLowerCase() === 'approved';

    return mdOk && procOk;
}