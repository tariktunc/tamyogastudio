import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// --- HELPER: Store Key Normalization (NO HEX DECODE) ---
function normalizeStoreKey(key) {
    const trimmedKey = String(key || '').trim();
    console.log('[DEBUG] Store Key: Forced RAW mode (no hex decode).');
    return trimmedKey;
}

// --- HELPER: Password Hashing (SHA1) ---
function createHashedPassword(password, terminalId) {
    const terminalIdEffective = String(terminalId).padStart(9, '0');
    const plain = password + terminalIdEffective;
    
    console.log('------------------------------------------------');
    console.log('[DEBUG] HashedPassword Input (Plain):', plain);
    console.log('------------------------------------------------');

    return crypto.createHash('sha1')
        .update(plain, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// --- HELPER: Main 3D Hash Construction ---
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

    console.log('------------------------------------------------');
    console.log('[DEBUG] MAIN HASH STRING TO SIGN:');
    console.log(plainText);
    console.log('------------------------------------------------');

    return crypto.createHash('sha1')
        .update(plainText, 'utf8')
        .digest('hex')
        .toUpperCase();
}

// =========================================================
// 3D CALLBACK VERIFICATION FIXED FOR OOS FULL MODE
// =========================================================

export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const receivedHash = postBody.HASH || postBody.hash; 
        const hashParams = postBody.hashparams || postBody.hashParams;

        if (!receivedHash || !rawStoreKey) {
            console.warn('[DEBUG] Callback Verify: Missing params (secure3dhash only mode).');
            return false;
        }

        const storeKey = normalizeStoreKey(rawStoreKey);

        let paramsList = [];
        if (hashParams) {
            paramsList = String(hashParams).split(':').filter(Boolean);
        } else {
            paramsList = [
                'clientid', 'oid', 'authcode', 'procreturncode', 'mdstatus',
                'txnamount', 'txncurrencycode', 'txntimestamp'
            ];
        }

        let plainText = '';
        for (const param of paramsList) {
            const keyLower = param.toLowerCase();
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === keyLower);
            const val = foundKey ? postBody[foundKey] : '';
            plainText += val;
        }

        plainText += storeKey;

        console.log('[DEBUG] Callback Verify String:', plainText);

        const calculatedHash = crypto.createHash('sha1')
            .update(plainText, 'utf8')
            .digest('base64');

        const isValid = (receivedHash === calculatedHash);

        console.log(`[DEBUG] Hash Match Result: ${isValid}`);

        return isValid;
    } catch (e) {
        console.error('[DEBUG] Verify Error:', e);
        return false;
    }
}

// =========================================================
// BUILD PAY FORM
// =========================================================

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
    const [rawTerminalId, merchantId, password, rawStoreKey, gatewayUrl] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'),
        getSecret('GARANTI_ENC_KEY'),
        getSecret('GARANTI_CALLBACK_PATH')
    ]);

    const provUserId = "PROVOOS";

    if (!rawTerminalId || !rawStoreKey || !password) throw new Error('Garanti Secrets missing!');

    const terminalIdRaw = String(rawTerminalId).trim();
    const terminalIdToSend = terminalIdRaw.padStart(9, '0');

    console.log('[DEBUG] Terminal IDs -> Raw:', terminalIdRaw, 'Padded:', terminalIdToSend);

    const amountClean = String(amountMinor);
    const taksit = (installments && installments !== '1' && installments !== '0') ? String(installments) : '';

    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    const hashedPassword = createHashedPassword(password, terminalIdToSend);
    const storeKey = normalizeStoreKey(rawStoreKey);
    const hash = createSecure3DHash({
        terminalId: terminalIdToSend,
        orderId,
        amount: amountClean,
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
        txnamount: amountClean,
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
