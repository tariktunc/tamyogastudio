import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

function createHashedPassword(password, terminalId) {
    const terminalIdPadded = String(terminalId).padStart(9, '0');
    const plain = password + terminalIdPadded;
    return crypto.createHash('sha1').update(plain, 'utf8').digest('hex').toUpperCase();
}

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

    // Debug için log (Tutarın noktasız geldiğini buradan teyit edeceğiz)
    console.log('Garanti Hash String (Debug):', plainText);
    return crypto.createHash('sha1').update(plainText, 'utf8').digest('hex').toUpperCase();
}

function resolveEst3DUrl(gatewayBase) {
    const base = String(gatewayBase || '').replace(/\/+$/, '');
    if (!base) throw new Error('Garanti BBVA gateway base eksik.');
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
    const terminalId = await getSecret('GARANTI_TERMINAL_ID');
    const gatewayBase = await getSecret('GARANTI_CALLBACK_PATH');
    const password = await getSecret('GARANTI_TERMINAL_PASSWORD');
    const merchantId = await getSecret('GARANTI_STORE_NO');
    const storeKey = await getSecret('GARANTI_ENC_KEY');
    const provUserId = await getSecret('GARANTI_PROVOOS_ID');
    const userId = await getSecret('GARANTI_USER_ID');

    if (!terminalId || !gatewayBase || !password || !merchantId || !storeKey || !provUserId || !userId) {
        console.error('Garanti BBVA secret bilgileri eksik.');
        throw new Error('Garanti BBVA yapılandırma hatası.');
    }

    if (!customerIp) {
        console.error('Garanti BBVA: Müşteri IP eksik!');
        throw new Error('Garanti IP hatası.');
    }

    // === DÜZELTME BURADA ===
    // Garanti Bankası tutarı Kuruş Ayracı Olmadan (Örn: 1.00 TL -> "100") ister.
    // Wix zaten bize 'amountMinor'ı (örn: 85000) veriyor.
    // Bunu 100'e bölüp string'e çevirmiyoruz, direkt kullanıyoruz.
    const amountForBank = String(amountMinor);
    // ======================

    const taksit = installments || '';

    const hashedPassword = createHashedPassword(password, terminalId);

    const now = new Date();
    const p = (n, len = 2) => String(n).padStart(len, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    const hash = createSecure3DHash({
        terminalId,
        orderId,
        amount: amountForBank, // Noktasız tutar (örn: "85000")
        okUrl: okUrl,
        failUrl: failUrl,
        txnType,
        installments: taksit,
        storeKey: storeKey,
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
        txnamount: amountForBank, // Noktasız tutar
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

export async function verifyCallbackHash(postBody) {
    try {
        const storeKey = await getSecret('GARANTI_ENC_KEY');
        const receivedHash = postBody.HASH || postBody.hash;
        const hashParams = postBody.hashparams;

        if (!receivedHash || !hashParams) {
            console.warn('Garanti verifyCallbackHash: Hash parametreleri eksik.');
            return false;
        }

        if (!storeKey) {
            console.warn('Garanti verifyCallbackHash: StoreKey bulunamadı.');
            return false;
        }

        const params = String(hashParams).split(':').filter(Boolean);
        let plainText = '';

        for (const p of params) {
            const value = postBody[p] || postBody[String(p).toLowerCase()] || '';
            plainText += value;
        }

        plainText += storeKey;

        const hashCalculated = crypto.createHash('sha1').update(plainText, 'utf8').digest('base64');

        const ok = receivedHash === hashCalculated;

        if (!ok) {
            console.warn('Garanti verifyCallbackHash: Uyuşmazlık', {
                expected: hashCalculated,
                got: receivedHash
            });
        }
        return ok;
    } catch (e) {
        console.error('Garanti verifyCallbackHash: Kritik hata', e);
        return false;
    }
}

export function isApproved(postBody) {
    const mdOk = ['1', '2', '3', '4'].includes(String(postBody.MDStatus || postBody.mdstatus || ''));
    const prcOk = String(postBody.ProcReturnCode || postBody.procreturncode || '') === '00';
    return mdOk && prcOk;
}