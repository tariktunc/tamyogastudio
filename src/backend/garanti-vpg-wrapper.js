import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- HELPER: Store Key Normalization & Logging ---
function normalizeStoreKey(key) {
    const trimmedKey = String(key || '').trim();
    
    // Hex Check: Only 0-9, A-F and even length
    const isHex = /^[0-9A-Fa-f]+$/.test(trimmedKey) && (trimmedKey.length % 2 === 0);
    
    if (isHex) {
        try {
            const decoded = Buffer.from(trimmedKey, 'hex').toString('utf8');
            console.log('[DEBUG] Store Key: HEX detected & decoded.');
            return decoded;
        } catch (e) {
            console.warn('[DEBUG] Store Key: Hex decode failed, using raw.');
            return trimmedKey;
        }
    }
    console.log('[DEBUG] Store Key: Treated as PLAIN TEXT.');
    return trimmedKey;
}

// --- HELPER: Password Hashing (SHA1) ---
function createHashedPassword(password, terminalId) {
    // FIX APPLIED: This function now receives the 9-digit ID.
    // Double check padding just in case, but it should already be padded by the caller.
    const terminalIdEffective = String(terminalId).padStart(9, '0');
    const plain = password + terminalIdEffective;
    
    console.log('------------------------------------------------');
    console.log('[DEBUG] HashedPassword Input (Plain):', plain);
    console.log('------------------------------------------------');

    return crypto.createHash('sha1').update(plain, 'utf8').digest('hex').toUpperCase();
}

// --- HELPER: Main 3D Hash Construction ---
function createSecure3DHash({ terminalId, orderId, amount, okUrl, failUrl, txnType, installments, storeKey, hashedPassword }) {
    // Sequence: TerminalID + OrderID + Amount + OkUrl + FailUrl + Type + Installment + StoreKey + HashedPassword
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

        // Collect values based on hashparams list
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
  amountMinor,
  currency = '949',
  okUrl,
  failUrl,
  installments = '',
  txnType = 'sales',
  customerIp,
  email = 'musteri@example.com'
}) {
    // 1. Retrieve Secrets
    const [rawTerminalId, merchantId, password, rawStoreKey, provUserId, gatewayUrl] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'),
        getSecret('GARANTI_ENC_KEY'),
        getSecret('GARANTI_PROVOOS_ID'),
        getSecret('GARANTI_CALLBACK_PATH')
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) throw new Error('Garanti Secrets missing!');

    // 2. Terminal ID Logic (THE FIX)
    // We verify the raw ID, then force 9-digit padding.
    const terminalIdRaw = String(rawTerminalId).trim();
    
    // Ensure we send "010380183" (9 digits) to align with 3D_OOS_FULL requirements
    const terminalIdToSend = terminalIdRaw.padStart(9, '0');
    
    console.log('------------------------------------------------');
    console.log('[DEBUG] Terminal ID Check:');
    console.log(`Raw (Secrets): "${terminalIdRaw}"`);
    console.log(`Padded (Used for ALL Hashes): "${terminalIdToSend}"`);
    console.log('------------------------------------------------');

    // 3. Data Formatting
    const amountMajor = (parseInt(String(amountMinor), 10) / 100).toFixed(2);
    // Installment logic: send empty string if 0 or 1
    const taksit = (installments && installments !== '1' && installments !== '0') ? String(installments) : '';
    
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 4. Hash Generation
    
    // *** CRITICAL FIX HERE: Use terminalIdToSend (9 digits) for Password Hash ***
    const hashedPassword = createHashedPassword(password, terminalIdToSend);
    
    const storeKey = normalizeStoreKey(rawStoreKey);

    const hash = createSecure3DHash({
        terminalId: terminalIdToSend, // Use 9 digits
        orderId,
        amount: amountMajor,
        okUrl,
        failUrl,
        txnType,
        installments: taksit,
        storeKey,
        hashedPassword
    });

    // 5. Endpoint
    const cleanBase = String(gatewayUrl || 'https://sanalposprov.garanti.com.tr').replace(/\/+$/, '');
    const actionUrl = `${cleanBase}/servlet/gt3dengine`;

    // 6. Form Fields
    const formFields = {
        mode: 'PROD',
        apiversion: 'v0.01',
        terminalprovuserid: provUserId,
        terminaluserid: provUserId,
        terminalmerchantid: merchantId,
        terminalid: terminalIdToSend, // Bank receives 9 digits
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

export function isApproved(postBody) {
    const mdStatus = String(postBody.mdstatus || postBody.MDStatus || '');
    const procReturnCode = String(postBody.procreturncode || postBody.ProcReturnCode || '');
    const response = String(postBody.response || postBody.Response || '');
    
    const mdOk = ['1', '2', '3', '4'].includes(mdStatus);
    const prcOk = procReturnCode === '00' || response.toLowerCase() === 'approved';

    return mdOk && prcOk;
}