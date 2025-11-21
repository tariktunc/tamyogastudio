import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

function cleanStr(str) {
    return String(str || '').trim();
}

// [ADIM 1] ŞİFRE HASHLEME (SHA1 - Latin1)
// mewebstudio Kütüphanesi Mantığı: SHA1(Password + PadlenmişTerminalID)
function createHashedPassword(password, terminalId) {
    const terminalIdPadded = String(terminalId).trim().padStart(9, '0');
    const plain = password + terminalIdPadded;
    
    console.warn(`[DEBUG] HashedPass Input: ${password.substring(0,2)}*** + ${terminalIdPadded}`);

    // Garanti için latin1 encoding en güvenli yoldur
    return crypto.createHash('sha1')
        .update(plain, 'latin1') 
        .digest('hex')
        .toUpperCase();
}

// [ADIM 2] ANA HASH OLUŞTURMA (SHA512)
// mewebstudio Kütüphanesi Mantığı: Tutar=Integer, Taksit=Boş (Peşin ise)
function createSecure3DHash({ terminalId, orderId, amount, currency, okUrl, failUrl, txnType, installments, storeKey, hashedPassword }) {
    const plainText = 
        terminalId +
        orderId +
        amount +
        currency +
        okUrl +
        failUrl +
        txnType +
        installments +
        storeKey +
        hashedPassword;

    console.warn('------------------------------------------------');
    console.warn('[DEBUG] HASH STRING (mewebstudio Mantığı: Tutar=TamSayı, Taksit=Boş):');
    console.warn(plainText);
    console.warn('------------------------------------------------');

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
  email = 'musteri@example.com'
}) {
    const [rawTerminalId, merchantId, password, rawStoreKey, gatewayUrl] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'),
        getSecret('GARANTI_ENC_KEY'),
        getSecret('GARANTI_CALLBACK_PATH')
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) throw new Error('Garanti Secrets missing!');

    const terminalIdRaw = cleanStr(rawTerminalId);
    const passwordClean = cleanStr(password);
    const storeKeyClean = cleanStr(rawStoreKey);
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);
    
    // [DÜZELTME 1] TUTAR: Kuruş Cinsinden Tam Sayı (Integer)
    // mewebstudio kütüphanesi: (int) round($amount * 100)
    // Wix amountMinor zaten bu formattadır. Örn: "4535000"
    // Nokta YOK.
    const amountNum = Math.floor(Number(amountMinor) / 100); // Eğer Wix 4535000 gönderiyorsa bu 45350 olur.
    // DİKKAT: Wix amountMinor zaten kuruş mu? Evet.
    // Eğer Wix 45350.00 TL için 4535000 gönderiyorsa, Garanti 45350 (100'e bölünmüş halini) değil,
    // direkt kuruş halini isteyebilir mi?
    // Garanti VPG dökümanı "100" = 1.00 TL der. Yani son iki hane kuruştur.
    // Wix 100 TL için 10000 gönderir.
    // O zaman bizim "10000" göndermemiz lazım.
    const amountClean = String(amountMinor); // Direkt Kuruş (Örn: 4535000)

    // [DÜZELTME 2] TAKSİT: Boş String (Peşin ise)
    // mewebstudio kütüphanesi: installment > 1 ? installment : ''
    let finalInstallment = '';
    if (installments && installments !== '0' && installments !== '1' && installments !== '') {
        finalInstallment = String(installments);
    }

    // 3. TİP: "sales"
    const finalType = txnType || 'sales';

    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    const hashedPassword = createHashedPassword(passwordClean, terminalIdRaw);

    const hash = createSecure3DHash({
        terminalId: terminalIdRaw,
        orderId,
        amount: amountClean,     // "4535000" (Kuruş)
        currency: currencyCode,
        okUrl,
        failUrl,
        txnType: finalType,      // "sales"
        installments: finalInstallment, // "" (Boş)
        storeKey: storeKeyClean,
        hashedPassword
    });

    // [DÜZELTME 3] URL: gt3dengine (Ödeme Sayfası)
    // VPServlet XML döndüğü için kullanılamaz.
    let actionUrl = 'https://sanalposprovtest.garantibbva.com.tr/servlet/gt3dengine';
    
    if (gatewayUrl) {
        // Secret'taki base url'i alıp sonuna doğru path'i ekliyoruz
        let base = String(gatewayUrl).replace('/VPServlet', '').replace('/servlet/gt3dengine', '').replace(/\/+$/, '');
        if(base.includes('garanti.com.tr') && !base.includes('garantibbva')) {
            base = base.replace('garanti.com.tr', 'garantibbva.com.tr');
        }
        actionUrl = `${base}/servlet/gt3dengine`;
    }

    const formFields = {
        mode: 'TEST',
        apiversion: '512',
        secure3dsecuritylevel: 'OOS_PAY', // HTML Formundaki değer
        terminalprovuserid: 'PROVAUT',
        terminaluserid: 'PROVAUT',
        terminalmerchantid: cleanStr(merchantId),
        terminalid: terminalIdRaw,
        orderid: orderId,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        txnamount: amountClean,         // "4535000"
        txncurrencycode: currencyCode,
        txntype: finalType,             // "sales"
        txninstallmentcount: finalInstallment, // ""
        successurl: okUrl,
        errorurl: failUrl,
        txntimestamp: timestamp,
        secure3dhash: hash,
        lang: 'tr'
    };

    return { actionUrl, formFields };
}

export async function verifyCallbackHash(postBody) {
    try {
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const storeKey = cleanStr(rawStoreKey);
        const responseHash = postBody.hash || postBody.HASH || postBody.secure3dhash;
        const hashParams = postBody.hashparams || postBody.hashParams || postBody.HASHPARAMS;

        if (!responseHash || !hashParams) return false;

        const paramList = String(hashParams).split(':');
        let digestData = '';
        for (const param of paramList) {
            if(!param) continue;
            const keyLower = param.toLowerCase();
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === keyLower);
            const value = foundKey ? postBody[foundKey] : '';
            digestData += value;
        }
        digestData += storeKey;
        const calculatedHash = crypto.createHash('sha512').update(digestData, 'utf8').digest('hex').toUpperCase();
        return (responseHash === calculatedHash);
    } catch (e) { return false; }
}

export function isApproved(postBody) {
    const procReturnCode = String(postBody.procreturncode || postBody.ProcReturnCode || '');
    return procReturnCode === '00';
}