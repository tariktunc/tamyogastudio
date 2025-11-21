import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

function cleanStr(str) {
    return String(str || '').trim();
}

// [ADIM 1] ŞİFRE HASHLEME (SHA1 - Latin1)
// Terminal ID burada zaten pad'lenmiş olarak gelecek
function createHashedPassword(password, terminalId) {
    // Terminal ID dışarıda pad'lendiği için burada tekrar işlem yapmaya gerek yok ama güvenlik için logluyoruz
    const plain = password + terminalId;
    
    console.log(`[DEBUG] HashedPass Input: ${password.substring(0,2)}*** + ${terminalId}`);

    return crypto.createHash('sha1')
        .update(plain, 'latin1') 
        .digest('hex')
        .toUpperCase();
}

// [ADIM 2] ANA HASH OLUŞTURMA (SHA512)
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

    console.log('------------------------------------------------');
    console.log('[DEBUG] HASH STRING:', plainText);
    console.log('------------------------------------------------');

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

    // *** KRİTİK DÜZELTME ***
    // Terminal ID her zaman 9 hane olmalı (Başına 0 eklenmeli)
    // Örn: 30691297 -> 030691297
    const terminalId = String(rawTerminalId || '').trim().padStart(9, '0');
    
    const passwordClean = cleanStr(password);
    const storeKeyClean = cleanStr(rawStoreKey);
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : String(currency);
    
    // Tutar Wix'ten kuruş (minor unit) olarak gelir (Örn: 100.00 TL -> "10000")
    // Garanti VPG direkt bu formatı kabul eder.
    const amountClean = String(amountMinor);

    // Taksit kontrolü (Peşin ise boş string)
    let finalInstallment = '';
    if (installments && installments !== '0' && installments !== '1') {
        finalInstallment = String(installments);
    }

    const finalType = txnType || 'sales';

    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;

    // 1. Şifreyi Hashle (Artık pad'lenmiş terminal ID kullanıyoruz)
    const hashedPassword = createHashedPassword(passwordClean, terminalId);

    // 2. Ana Hash'i oluştur
    const hash = createSecure3DHash({
        terminalId: terminalId, // Düzeltilmiş (0'lı) ID
        orderId,
        amount: amountClean,
        currency: currencyCode,
        okUrl,
        failUrl,
        txnType: finalType,
        installments: finalInstallment,
        storeKey: storeKeyClean,
        hashedPassword
    });

    // URL Belirleme
    let actionUrl = 'https://sanalposprov.garantibbva.com.tr/servlet/gt3dengine'; // PROD Default
    
    if (gatewayUrl) {
        // Secret'ta verilen URL varsa onu kullan, yoksa default prod.
        let base = String(gatewayUrl).replace('/VPServlet', '').replace('/servlet/gt3dengine', '').replace(/\/+$/, '');
        // Eski garanti.com.tr domaini varsa yenisiyle değiştir
        if(base.includes('garanti.com.tr') && !base.includes('garantibbva')) {
            base = base.replace('garanti.com.tr', 'garantibbva.com.tr');
        }
        actionUrl = `${base}/servlet/gt3dengine`;
    }

    const formFields = {
        mode: 'PROD', // Canlı ortam için PROD (Test için TEST)
        apiversion: '512',
        secure3dsecuritylevel: 'OOS_PAY',
        terminalprovuserid: 'PROVAUT',
        terminaluserid: 'PROVAUT',
        terminalmerchantid: cleanStr(merchantId),
        terminalid: terminalId, // Bankaya giden formda da 0'lı ID olmalı
        orderid: orderId,
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        txnamount: amountClean,
        txncurrencycode: currencyCode,
        txntype: finalType,
        txninstallmentcount: finalInstallment,
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
        
        // Gelen parametrelerin key'leri küçük/büyük harf değişebilir, normalize edelim
        const getParam = (key) => {
             const found = Object.keys(postBody).find(k => k.toLowerCase() === key.toLowerCase());
             return found ? postBody[found] : '';
        }

        const responseHash = getParam('hash') || getParam('secure3dhash');
        const hashParams = getParam('hashparams');

        if (!responseHash || !hashParams) {
            console.warn('Hash parameters missing in callback');
            return false;
        }

        // Hashparams stringini : ile bölüp değerleri birleştiriyoruz
        const paramList = String(hashParams).split(':');
        let digestData = '';
        
        for (const param of paramList) {
            if(!param) continue;
            digestData += getParam(param); // Parametre değerini postBody'den al
        }
        
        // En sona StoreKey ekle
        digestData += storeKey;

        const calculatedHash = crypto.createHash('sha512').update(digestData, 'utf8').digest('hex').toUpperCase();
        
        const isValid = (responseHash.toUpperCase() === calculatedHash);
        if (!isValid) {
             console.warn('Hash Mismatch details:', {
                 incoming: responseHash,
                 calculated: calculatedHash,
                 rawString: digestData
             });
        }
        return isValid;

    } catch (e) { 
        console.error('Verify Hash Error', e);
        return false; 
    }
}

export function isApproved(postBody) {
    // Key normalization
    const getParam = (key) => {
        const found = Object.keys(postBody).find(k => k.toLowerCase() === key.toLowerCase());
        return found ? postBody[found] : '';
   }
   
   const mdStatus = getParam('mdstatus');
   const procReturnCode = getParam('procreturncode');
   const response = getParam('response');

   // MDStatus 1=Tam Doğrulama, 2=Kart Sahibi Kayıtlı Değil(bazı durumlarda), 3=Kart Kayıtlı Değil, 4=Doğrulama denemesi
   // Genellikle 1 beklenir.
   const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
   
   const procOk = String(procReturnCode) === '00' || String(response).toLowerCase() === 'approved';
   
   return mdOk && procOk;
}