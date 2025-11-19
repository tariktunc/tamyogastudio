import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- HELPER: Store Key Normalization ---
function normalizeStoreKey(key) {
    const trimmedKey = String(key || '').trim();
    const isHex = /^[0-9A-Fa-f]+$/.test(trimmedKey) && (trimmedKey.length % 2 === 0);
    
    if (isHex) {
        try {
            return Buffer.from(trimmedKey, 'hex').toString('utf8');
        } catch (e) {
            return trimmedKey;
        }
    }
    return trimmedKey;
}

// --- HELPER: Password Hashing (UPDATED LOGIC) ---
function createHashedPassword(password, terminalIdForHash) {
    // FIX: Using the ID exactly as provided in secrets (likely 8 digits), NOT forced padding.
    // If the bank expects 8 digits here, the previous padding was breaking the hash.
    const plain = password + terminalIdForHash;
    
    console.log('[DEBUG] HashedPassword Input (Plain):', plain);
    return crypto.createHash('sha1').update(plain, 'utf8').digest('hex').toUpperCase();
}

// --- HELPER: Main 3D Hash ---
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

    console.log('[DEBUG] MAIN HASH STRING TO SIGN:', plainText);
    return crypto.createHash('sha1').update(plainText, 'utf8').digest('hex').toUpperCase();
}

export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const receivedHash = postBody.HASH || postBody.hash;
        const hashParams = postBody.hashparams || postBody.hashParams;

        if (!receivedHash || !hashParams || !rawStoreKey) return false;

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
        
        const calculatedHash = crypto.createHash('sha1').update(plainText, 'utf8').digest('base64');
        return receivedHash === calculatedHash;
    } catch (e) {
        console.error('Verify Error:', e);
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
    const [rawTerminalId, merchantId, password, rawStoreKey, provUserId, gatewayUrl] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'),
        getSecret('GARANTI_ENC_KEY'),
        getSecret('GARANTI_PROVOOS_ID'),
        getSecret('GARANTI_CALLBACK_PATH')
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) throw new Error('Garanti Secrets missing!');

    // 1. Terminal ID Logic
    // We keep raw ID for password hashing, but pad it for the Request if needed.
    const terminalIdRaw = String(rawTerminalId).trim(); 
    const terminalIdPadded = terminalIdRaw.padStart(9, '0');

    // *** DECISION: Which one to send to the bank? ***
    // Logs showed the bank returning "010..." (9 digits), so we stick to Padded for the Request.
    const terminalIdToSend = terminalIdPadded;

    console.log(`[DEBUG] Terminal IDs -> Raw: ${terminalIdRaw}, Padded: ${terminalIdPadded}`);

    // 2. Format Data
    const amountMajor = (parseInt(String(amountMinor), 10) / 100).toFixed(2);
    const taksit = (installments && installments !== '1' && installments !== '0') ? String(installments) : '';
    
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 3. Hash Generation
    // *** FIX: Use RAW ID for Password Hash ***
    const hashedPassword = createHashedPassword(password, terminalIdRaw);
    
    const storeKey = normalizeStoreKey(rawStoreKey);

    const hash = createSecure3DHash({
        terminalId: terminalIdToSend, // Use 9 digits for the main string
        orderId,
        amount: amountMajor,
        okUrl,
        failUrl,
        txnType,
        installments: taksit,
        storeKey,
        hashedPassword
    });

    const cleanBase = String(gatewayUrl || 'https://sanalposprov.garanti.com.tr').replace(/\/+$/, '');
    const actionUrl = `${cleanBase}/servlet/gt3dengine`;

    const formFields = {
        mode: 'PROD',
        apiversion: 'v0.01',
        terminalprovuserid: provUserId,
        terminaluserid: provUserId,
        terminalmerchantid: merchantId,
        terminalid: terminalIdToSend,
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