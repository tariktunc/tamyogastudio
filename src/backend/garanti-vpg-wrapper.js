import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

function clean(val) {
    return String(val || '').trim();
}

/**
 * SHA1 (Password Hash)
 * Kural: Password + PadLeft(TerminalID, 9, '0')
 */
function createHashedPassword(password, terminalIdPadded) {
    const raw = password + terminalIdPadded;
    // ISO-8859-1 (Latin1) encoding kullanıyoruz
    return crypto.createHash('sha1').update(raw, 'latin1').digest('hex').toUpperCase();
}

/**
 * SHA512 (Security Hash)
 * Sıralama: TerminalID + OrderID + Amount + Currency + OkUrl + FailUrl + Type + Installment + StoreKey + HashedPassword
 */
function createSecure3DHash(params) {
    const str = 
        params.terminalId +     // Burası Padded (9 hane) mi yoksa Raw (8 hane) mi olmalı? Garanti genelde Padded sever.
        params.orderId + 
        params.amount + 
        params.currency + 
        params.okUrl + 
        params.failUrl + 
        params.type + 
        params.installment + 
        params.storeKey + 
        params.hashedPassword;

    return {
        hash: crypto.createHash('sha512').update(str, 'latin1').digest('hex').toUpperCase(),
        debugString: str
    };
}

export async function buildPayHostingForm(options) {
    const { orderId, amountMinor, okUrl, failUrl, installments, txnType, customerIp, email } = options;

    // Secrets
    const [rawTermId, storeNo, password, rawStoreKey] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'),
        getSecret('GARANTI_ENC_KEY')
    ]);

    // 1. Terminal ID Hazırlığı
    const termIdRaw = clean(rawTermId).replace(/^0+/, ''); // 8 Hane (örn: 30691297)
    const termIdPad = termIdRaw.padStart(9, '0');          // 9 Hane (örn: 030691297)

    // 2. Diğer Değerler
    const amount = String(amountMinor); // "100"
    const currency = '949';
    const inst = installments || ''; // Boşsa boş string, test için '1' gönderiyoruz service'den.
    const type = txnType || 'sales';
    const storeKey = clean(rawStoreKey);

    // 3. Hash Hesaplama
    // A. Password Hash -> Kesinlikle 9 Hane ID ile
    const passHash = createHashedPassword(clean(password), termIdPad);

    // B. Main Hash -> BURASI KRİTİK. 
    // "Input Invalid" alıyorsak Form'a Raw(8) koyuyoruz.
    // "Hash Error" alıyorsak Hash'e Pad(9) koymayı deniyoruz.
    // Garanti OOS dökümanları genellikle Hash içinde de Padded ID ister.
    const { hash, debugString } = createSecure3DHash({
        terminalId: termIdRaw, // DİKKAT: Formda 8 gidiyorsa hash'e de 8 koyalım (Önceki denemede hash tutmadı).
                               // Eğer yine MD7 alırsak burayı termIdPad (9) yapacağız.
                               // Şimdilik Tutarlılık İlkesi gereği Form = Hash = 8 hane deniyoruz.
        orderId,
        amount,
        currency,
        okUrl,
        failUrl,
        type,
        installment: inst,
        storeKey,
        hashedPassword: passHash
    });

    const formFields = {
        mode: 'TEST',
        apiversion: '512',
        secure3dsecuritylevel: 'OOS_PAY',
        terminalprovuserid: 'PROVAUT',
        terminaluserid: 'PROVAUT',
        terminalmerchantid: clean(storeNo),
        terminalid: termIdRaw, // FORM: 8 Hane (30691297) - Banka 9 haneyi reddediyor (Input error)
        orderid: orderId,
        customeripaddress: customerIp,
        customeremailaddress: email,
        txnamount: amount,
        txncurrencycode: currency,
        txntype: type,
        txninstallmentcount: inst,
        successurl: okUrl,
        errorurl: failUrl,
        secure3dhash: hash,
        lang: 'tr',
        txntimestamp: new Date().toISOString()
    };

    // Debug için hash string'ini de dönüyoruz
    return { 
        actionUrl: 'https://sanalposprovtest.garantibbva.com.tr/servlet/gt3dengine', 
        formFields,
        debugString
    };
}

export async function verifyCallbackHash(post) {
    try {
        const storeKey = clean(await getSecret('GARANTI_ENC_KEY'));
        
        // Gelen parametreleri normalize et
        const p = (k) => post[k] || '';
        
        const bankHash = p('hash') || p('secure3dhash');
        const hashParams = p('hashparams');
        
        if (!bankHash || !hashParams) {
            console.warn('Verify: Hash params eksik');
            return false;
        }

        // HashParams'daki sıraya göre string oluştur
        const keys = hashParams.split(':');
        let rawStr = '';
        keys.forEach(key => {
            if(key) rawStr += p(key.toLowerCase());
        });
        rawStr += storeKey; // En sona storeKey ekle

        // Hashle
        const myHash = crypto.createHash('sha512').update(rawStr, 'latin1').digest('hex').toUpperCase();

        console.log('VERIFY HASH INPUT:', rawStr);
        console.log('VERIFY HASH CALC:', myHash);
        console.log('VERIFY HASH BANK:', bankHash);

        return myHash === bankHash.toUpperCase();

    } catch (e) {
        console.error(e);
        return false;
    }
}

export function isApproved(post) {
    const md = post['mdstatus'];
    const code = post['procreturncode'];
    const resp = post['response'];
    return ['1','2','3','4'].includes(md) && (code === '00' || String(resp).toLowerCase() === 'approved');
}