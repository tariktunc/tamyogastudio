import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

function clean(val) {
    return String(val || '').trim();
}

function createHashedPassword(password, terminalId) {
    const paddedId = terminalId.padStart(9, '0'); 
    const rawData = password + paddedId;

    return crypto.createHash('sha1')
        .update(rawData, 'latin1')
        .digest('hex')
        .toUpperCase();
}

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

    return crypto.createHash('sha512')
        .update(plainText, 'latin1')
        .digest('hex')
        .toUpperCase();
}

export async function buildPayHostingForm({ orderId, amountMinor, currency = '949', okUrl, failUrl, installments = '', txnType = 'sales', customerIp, email = 'test@example.com' }) {
    const [rawTerminalId, storeNo, password, rawStoreKey] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'),
        getSecret('GARANTI_ENC_KEY')
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) {
        throw new Error('Garanti Secrets eksik!');
    }

    const terminalIdRaw = clean(rawTerminalId).replace(/^0+/, '');
    const storeKey = clean(rawStoreKey);
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : clean(currency);
    const amount = String(amountMinor);

    let installmentStr = String(installments || '1');
    if (installmentStr === '0' || installmentStr === '') installmentStr = '1';

    const type = txnType || 'sales';

    const hashedPassword = createHashedPassword(clean(password), terminalIdRaw);
    const securityHash = createSecure3DHash({
        terminalId: terminalIdRaw,
        orderId,
        amount,
        currency: currencyCode,
        okUrl,
        failUrl,
        txnType: type,
        installment: installmentStr,
        storeKey,
        hashedPassword
    });

    const actionUrl = 'https://sanalposprovtest.garantibbva.com.tr/servlet/gt3dengine';

    const formFields = {
        mode: 'TEST',
        apiversion: '512',
        secure3dsecuritylevel: 'OOS_PAY',
        terminalprovuserid: 'PROVAUT',
        terminaluserid: 'PROVAUT',
        terminalmerchantid: storeNo,
        terminalid: terminalIdRaw,
        orderid,
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

    const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
    const procOk = String(procReturnCode) === '00' || String(response).toLowerCase() === 'approved';

    return mdOk && procOk;
}
