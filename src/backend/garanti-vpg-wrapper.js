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
    // Terminal ID'yi 9 haneye tamamla
    const paddedId = terminalId.padStart(9, '0'); 
    const rawData = password + paddedId;
    
    console.log('[Garanti-Wrapper] Password Hash - Terminal ID (padded):', paddedId);
    console.log('[Garanti-Wrapper] Password Hash - Raw Data:', `***${password.length}chars*** + ${paddedId}`);

    const hash = crypto.createHash('sha1')
        .update(rawData, 'latin1')
        .digest('hex')
        .toUpperCase();
    
    console.log('[Garanti-Wrapper] Password Hash Result:', hash);
    return hash;
}

/**
 * [ADIM 2] Güvenlik Hash'i (SHA512)
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

    console.log('[Garanti-Wrapper] Main Hash Components:');
    console.log('  TerminalID:', data.terminalId);
    console.log('  OrderID:', data.orderId);
    console.log('  Amount:', data.amount);
    console.log('  Currency:', data.currency);
    console.log('  OkURL:', data.okUrl);
    console.log('  FailURL:', data.failUrl);
    console.log('  TxnType:', data.txnType);
    console.log('  Installment:', data.installment);
    console.log('  StoreKey:', `***${data.storeKey.length}chars***`);
    console.log('  HashedPassword:', data.hashedPassword);

    const hash = crypto.createHash('sha512')
        .update(plainText, 'latin1')
        .digest('hex')
        .toUpperCase();
    
    console.log('[Garanti-Wrapper] Main Hash Result:', hash);
    return hash;
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
    console.log('\n========== GARANTI PAYMENT REQUEST ==========');
    console.log('Order ID:', orderId);
    console.log('Amount (kuruş):', amountMinor);
    console.log('Currency:', currency);
    
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

    console.log('Secrets loaded:');
    console.log('  Terminal ID (raw):', rawTerminalId);
    console.log('  Store No:', storeNo);
    console.log('  Password length:', password.length);
    console.log('  Store Key length:', rawStoreKey.length);

    // 2. Değerleri temizle ve hazırla
    const terminalId = clean(rawTerminalId);
    const storeKey = clean(rawStoreKey);
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : clean(currency);
    const amount = String(amountMinor); // Kuruş cinsinden

    // Taksit kontrolü
    let installmentStr = String(installments || '');
    if (installmentStr === '0' || installmentStr === '') {
        installmentStr = ''; // Peşin için BOŞ gönder
    }

    const type = txnType || 'sales';

    console.log('\nProcessed values:');
    console.log('  Terminal ID (cleaned):', terminalId);
    console.log('  Currency Code:', currencyCode);
    console.log('  Amount:', amount);
    console.log('  Installment:', installmentStr || '(empty for cash)');
    console.log('  Type:', type);

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

    // 4. Banka URL
    const actionUrl = 'https://sanalposprovtest.garantibbva.com.tr/servlet/gt3dengine';

    // 5. Form Alanları - ÖNEMLI: Garanti OOS için doğru yapı
    const formFields = {
        mode: 'TEST',
        apiversion: '512',
        secure3dsecuritylevel: 'OOS_PAY',
        terminalprovuserid: 'PROVAUT',
        terminaluserid: 'PROVAUT',
        terminalmerchantid: clean(storeNo),
        terminalid: terminalId,
        txntype: type,
        txnamount: amount,
        txncurrencycode: currencyCode,
        txninstallmentcount: installmentStr,
        orderid: orderId,
        successurl: okUrl,
        errorurl: failUrl,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        secure3dhash: securityHash,
        lang: 'tr',
        refreshtime: '10'
    };

    console.log('\n========== FORM FIELDS TO SEND ==========');
    Object.entries(formFields).forEach(([key, value]) => {
        if (key === 'secure3dhash') {
            console.log(`${key}: ${value}`);
        } else {
            console.log(`${key}: ${value}`);
        }
    });
    console.log('===========================================\n');

    return { actionUrl, formFields };
}

/**
 * Callback Hash Doğrulama
 */
export async function verifyCallbackHash(postBody) {
    try {
        console.log('\n========== GARANTI CALLBACK RECEIVED ==========');
        console.log('Full POST body keys:', Object.keys(postBody));
        
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const storeKey = clean(rawStoreKey);

        const getParam = (key) => {
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === key.toLowerCase());
            return foundKey ? postBody[foundKey] : null;
        };

        // Tüm kritik alanları logla
        console.log('Critical callback fields:');
        console.log('  mdstatus:', getParam('mdstatus'));
        console.log('  procreturncode:', getParam('procreturncode'));
        console.log('  response:', getParam('response'));
        console.log('  mderrormessage:', getParam('mderrormessage'));
        console.log('  errmsg:', getParam('errmsg'));

        const responseHash = getParam('hash') || getParam('secure3dhash');
        const hashParams = getParam('hashparams');

        console.log('  hash/secure3dhash:', responseHash ? 'Present' : 'MISSING');
        console.log('  hashparams:', hashParams || 'MISSING');

        if (!responseHash || !hashParams) {
            console.error('[Garanti-Wrapper] ⚠️ Hash verification SKIPPED - Missing hash or hashparams');
            console.error('This indicates the bank rejected the transaction before completing 3D authentication');
            return false;
        }

        const paramList = String(hashParams).split(':');
        let digestData = '';
        
        console.log('[Garanti-Wrapper] Hash params order:', hashParams);
        console.log('[Garanti-Wrapper] Building hash from params:');
        
        for (const param of paramList) {
            if (!param) continue;
            const val = getParam(param);
            if (val !== null && val !== undefined) {
                console.log(`  ${param}: ${val}`);
                digestData += val;
            }
        }
        
        digestData += storeKey;
        console.log(`  storekey: ***${storeKey.length}chars***`);

        const calculatedHash = crypto.createHash('sha512')
            .update(digestData, 'latin1')
            .digest('hex')
            .toUpperCase();

        const isValid = (responseHash.toUpperCase() === calculatedHash);
        
        if (!isValid) {
            console.error('[Garanti-Wrapper] ❌ Hash mismatch!');
            console.error('Expected:', calculatedHash);
            console.error('Received:', responseHash.toUpperCase());
        } else {
            console.log('[Garanti-Wrapper] ✅ Hash verification successful');
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

    console.log('[Garanti-Wrapper] Approval check:');
    console.log('  MDStatus:', mdStatus);
    console.log('  ProcReturnCode:', procReturnCode);
    console.log('  Response:', response);

    const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
    const procOk = String(procReturnCode) === '00' || String(response).toLowerCase() === 'approved';

    const approved = mdOk && procOk;
    console.log('  Result:', approved ? '✅ APPROVED' : '❌ REJECTED');

    return approved;
}