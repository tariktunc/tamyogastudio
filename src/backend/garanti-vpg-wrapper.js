import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

function normalizeStoreKey(key) {
    const trimmedKey = String(key || '').trim();
    console.log('[DEBUG] Store Key: Forced RAW mode (no hex decode).');
    return trimmedKey;
}


// --- HELPER: Password Hashing (SHA1) ---
function createHashedPassword(password, terminalId) {
    // FIX APPLIED: Terminal ID'nin 9 haneli (padded) versiyonu kullanılır
    const terminalIdEffective = String(terminalId).padStart(9, '0');
    const plain = password + terminalIdEffective;
    
    console.log('------------------------------------------------');
    console.log('[DEBUG] HashedPassword Input (Plain):', plain);
    console.log('------------------------------------------------');

    return crypto.createHash('sha1').update(plain, 'utf8').digest('hex').toUpperCase();
}

// --- HELPER: Main 3D Hash Construction ---
function createSecure3DHash({ terminalId, orderId, amount, okUrl, failUrl, txnType, installments, storeKey, hashedPassword }) {
    // Sıralama: TerminalID + OrderID + Amount + OkUrl + FailUrl + Type + Installment + StoreKey + HashedPassword
    const plainText = 
        terminalId +
        orderId +
        amount + // CRITICAL: Kurus/Minor unit olarak eklendi
        okUrl +
        failUrl +
        txnType +
        installments +
        storeKey +
        hashedPassword;

    console.log('------------------------------------------------');
    console.log('[DEBUG] MAIN HASH STRING TO SIGN:');
    console.log(plainText);
    console.log('------------------------------------------------');

    return crypto.createHash('sha1').update(plainText, 'utf8').digest('hex').toUpperCase();
}

/**
 * Callback Hash Verification
 */
export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const receivedHash = postBody.HASH || postBody.hash;
        const hashParams = postBody.hashparams || postBody.hashParams;

        if (!receivedHash || !hashParams || !rawStoreKey) {
            console.warn('[DEBUG] Callback Verify: Missing params.');
            return false;
        }

        const storeKey = normalizeStoreKey(rawStoreKey);
        const paramsList = String(hashParams).split(':').filter(Boolean);
        let plainText = '';

        for (const param of paramsList) {
            const keyLower = param.toLowerCase();
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === keyLower);
            const val = foundKey ? postBody[foundKey] : '';
            plainText += val;
        }

        plainText += storeKey;
        
        console.log('[DEBUG] Callback Verify String:', plainText);

        const calculatedHash = crypto.createHash('sha1').update(plainText, 'utf8').digest('base64');
        
        const isValid = (receivedHash === calculatedHash);
        console.log(`[DEBUG] Hash Match Result: ${isValid}`);
        
        return isValid;
    } catch (e) {
        console.error('[DEBUG] Verify Error:', e);
        return false;
    }
}

// --- MAIN FUNCTION ---

export async function buildPayHostingForm({
  orderId,
  amountMinor, // Kurus cinsinden geliyor (Örn: 290000)
  currency = '949',
  okUrl,
  failUrl,
  installments = '',
  txnType = 'sales',
  customerIp,
  email = 'musteri@example.com'
}) {
    // 1. Secret'ları Çek
    const [rawTerminalId, merchantId, password, rawStoreKey, gatewayUrl] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'),
        getSecret('GARANTI_ENC_KEY'),
        getSecret('GARANTI_CALLBACK_PATH')
    ]);

    // 2. Provision User ID'yi Hardcode et (Önceki karara göre)
    const provUserId = "PROVOOS";
    
    if (!rawTerminalId || !rawStoreKey || !password) throw new Error('Garanti Secrets missing!');

    // 3. Terminal ID Logic (9-Hane Düzeltmesi)
    const terminalIdRaw = String(rawTerminalId).trim();
    const terminalIdToSend = terminalIdRaw.padStart(9, '0'); // 010380183
    
    console.log('[DEBUG] Terminal IDs -> Raw:', terminalIdRaw, 'Padded:', terminalIdToSend);

    // 4. Data Formatting
    // KRİTİK FIX: amountMinor (kuruş) doğrudan tamsayı stringi olarak kullanılır.
    const amountClean = String(amountMinor); 

    // Taksit boşsa, '1' ise veya '0' ise hash hesaplamasına boş string olarak girer
    const taksit = (installments && installments !== '1' && installments !== '0') ? String(installments) : '';
    
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 5. Hash Generation
    // Password Hash (9 digits used)
    const hashedPassword = createHashedPassword(password, terminalIdToSend);
    
    // Store Key Decode
    const storeKey = normalizeStoreKey(rawStoreKey);

    const hash = createSecure3DHash({
        terminalId: terminalIdToSend, // 9 digits used
        orderId,
        amount: amountClean, // Tutar kuruş cinsinden (Örn: "290000")
        okUrl,
        failUrl,
        txnType,
        installments: taksit,
        storeKey,
        hashedPassword
    });

    // 6. Endpoint
    const cleanBase = String(gatewayUrl || 'https://sanalposprov.garanti.com.tr').replace(/\/+$/, '');
    const actionUrl = `${cleanBase}/servlet/gt3dengine`;

    // 7. Form Fields
    const formFields = {
        mode: 'PROD',
        apiversion: 'v0.01',
        terminalprovuserid: provUserId, // Hardcoded PROVOOS
        terminaluserid: provUserId,     // Hardcoded PROVOOS
        terminalmerchantid: merchantId,
        terminalid: terminalIdToSend, 
        orderid: orderId,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        txnamount: amountClean, // CRITICAL FIX: Form alanına tamsayı kuruş (minor unit) gönderilir
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

export function isApproved(postBody) {
    const mdStatus = String(postBody.mdstatus || postBody.MDStatus || '');
    const procReturnCode = String(postBody.procreturncode || postBody.ProcReturnCode || '');
    const response = String(postBody.response || postBody.Response || '');
    
    const mdOk = ['1', '2', '3', '4'].includes(mdStatus);
    const prcOk = procReturnCode === '00' || response.toLowerCase() === 'approved';

    return mdOk && prcOk;
}