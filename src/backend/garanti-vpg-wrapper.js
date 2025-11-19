import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

// Terminal Şifresi Hashleme (SHA1 + HEX + Upper)
function createHashedPassword(password, terminalId) {
    const terminalIdPadded = String(terminalId).padStart(9, '0');
    const plain = password + terminalIdPadded;
    return crypto.createHash('sha1').update(plain, 'utf8').digest('hex').toUpperCase();
}

// 3D Secure Hash Oluşturma (PHP 3DOOSPay.php Mantığı)
function createSecure3DHash({
    terminalId,
    orderId,
    amount,
    okUrl,
    failUrl,
    txnType,
    installments,
    storeKey,
    hashedPassword
}) {
    // PHP Formülü: TerminalID + OrderID + Amount + SuccessURL + ErrorURL + Type + Installment + StoreKey + SecurityData
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

    console.log('HASH DEBUG (Plain):', plainText); // Loglarda kontrol için
    return crypto.createHash('sha1').update(plainText, 'utf8').digest('hex').toUpperCase();
}

function resolveEst3DUrl(gatewayBase) {
    const base = String(gatewayBase || '').replace(/\/+$/, '');
    return `${base}/servlet/gt3dengine`;
}

export async function buildPayHostingForm({
    orderId,
    amountMinor,
    currency = '949',
    okUrl,
    failUrl,
    customerIp,
    installments = '',
    txnType = 'sales'
}) {
    // Secretları çek
    const terminalId = await getSecret('GARANTI_TERMINAL_ID');
    const gatewayBase = await getSecret('GARANTI_CALLBACK_PATH');
    const password = await getSecret('GARANTI_TERMINAL_PASSWORD'); // Gvp+2024Pos
    const merchantId = await getSecret('GARANTI_STORE_NO');
    const storeKey = await getSecret('GARANTI_ENC_KEY'); // GvP2024TamYogaSecureKy9x OLMALI
    const provUserId = await getSecret('GARANTI_PROVOOS_ID');
    
    // OOS modelinde UserID genellikle PROVOOS'tur.
    const userId = provUserId; 

    if (!terminalId || !gatewayBase || !password || !storeKey) {
        throw new Error('Garanti Secret Eksik!');
    }

    // Tutar: 1.00 TL -> "100" (Kuruş ayracı yok, string)
    const amountForBank = String(amountMinor);

    // Taksit: Yoksa boş string
    const taksit = installments || '';

    // 1. Adım: Password Hash
    const hashedPassword = createHashedPassword(password, terminalId);

    // Zaman Damgası (Sadece forma eklenir, Hash'e katılmaz!)
    const now = new Date();
    const p = (n, len = 2) => String(n).padStart(len, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 2. Adım: Ana Hash
    const hash = createSecure3DHash({
        terminalId,
        orderId,
        amount: amountForBank,
        okUrl,
        failUrl,
        txnType,
        installments: taksit,
        storeKey,
        hashedPassword
    });

    const actionUrl = resolveEst3DUrl(gatewayBase);
    const customerEmail = 'dummy@tamyogastudio.com';

    const formFields = {
        apiversion: 'v0.01',
        mode: 'PROD',
        lang: 'tr',
        terminalid: terminalId,
        terminalmerchantid: merchantId,
        terminaluserid: userId,
        terminalprovuserid: provUserId,
        orderid: orderId,
        txnamount: amountForBank,
        txncurrencycode: currency,
        txntype: txnType,
        txninstallmentcount: taksit,
        successurl: okUrl,
        errorurl: failUrl,
        secure3dsecuritylevel: '3D_OOS_FULL',
        secure3dhash: hash,
        customeripaddress: customerIp,
        customeremailaddress: customerEmail,
        txntimestamp: timestamp
    };

    return { actionUrl, formFields };
}

// Callback Doğrulama (Base64 + StoreKey)
export async function verifyCallbackHash(postBody) {
    try {
        const storeKey = await getSecret('GARANTI_ENC_KEY');
        const receivedHash = postBody.HASH || postBody.hash;
        const hashParams = postBody.hashparams;

        if (!receivedHash || !hashParams || !storeKey) return false;

        // PHP Gate3D dosyasına göre ayırıcı ':'
        const params = String(hashParams).split(':').filter(Boolean);
        let plainText = '';

        for (const p of params) {
            // Gelen parametreleri birleştir
            const val = postBody[p] || postBody[String(p).toLowerCase()] || '';
            plainText += val;
        }

        // Sona StoreKey ekle
        plainText += storeKey;

        // SHA1 -> Base64
        const hashCalculated = crypto.createHash('sha1').update(plainText, 'utf8').digest('base64');
        
        return receivedHash === hashCalculated;
    } catch (e) {
        console.error('Verify Error', e);
        return false;
    }
}

export function isApproved(postBody) {
    const mdOk = ['1', '2', '3', '4'].includes(String(postBody.MDStatus || postBody.mdstatus || ''));
    const prcOk = String(postBody.ProcReturnCode || postBody.procreturncode || '') === '00';
    return mdOk && prcOk;
}