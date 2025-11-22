import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

function clean(val) {
    return String(val || '').trim();
}

/**
 * [ADIM 1] Şifre Hashleme (SHA1)
 * KRITIK: Terminal ID'yi 9 haneye tamamla (ör: 30691297 -> 030691297)
 */
function createHashedPassword(password, terminalId) {
    // Garanti, şifre hashinde Terminal ID'yi 9 haneye tamamlanmış halde bekler
    const paddedId = terminalId.padStart(9, '0'); 
    const rawData = password + paddedId;
    
    console.log('[Hash-Step1] Terminal ID (raw):', terminalId);
    console.log('[Hash-Step1] Terminal ID (padded to 9):', paddedId);
    console.log('[Hash-Step1] Password length:', password.length);

    const hash = crypto.createHash('sha1')
        .update(rawData, 'latin1')
        .digest('hex')
        .toUpperCase();
    
    console.log('[Hash-Step1] SHA1 Result:', hash);
    return hash;
}

/**
 * [ADIM 2] Güvenlik Hash'i (SHA512)
 * KRITIK: Terminal ID formdaki ile aynı olmalı (8 veya 9 hane)
 */
function createSecure3DHash(data) {
    // Garanti'nin beklediği EXACT sıra:
    const plainText = 
        data.terminalId +      // Olduğu gibi (8 veya 9 hane)
        data.orderId + 
        data.amount + 
        data.currency + 
        data.okUrl + 
        data.failUrl + 
        data.txnType + 
        data.installment +     // Boş olabilir ama field olmalı
        data.storeKey + 
        data.hashedPassword;   // 9 haneli ID ile üretilmiş şifre

    console.log('[Hash-Step2] Hash String Components:');
    console.log('  1. TerminalID:', data.terminalId, `(${data.terminalId.length} chars)`);
    console.log('  2. OrderID:', data.orderId);
    console.log('  3. Amount:', data.amount);
    console.log('  4. Currency:', data.currency);
    console.log('  5. OkURL:', data.okUrl);
    console.log('  6. FailURL:', data.failUrl);
    console.log('  7. TxnType:', data.txnType);
    console.log('  8. Installment:', `"${data.installment}"`);
    console.log('  9. StoreKey:', `***${data.storeKey.length}***`);
    console.log(' 10. HashedPwd:', data.hashedPassword);
    
    // Concatenated string için debug
    console.log('[Hash-Step2] Full String Length:', plainText.length);

    const hash = crypto.createHash('sha512')
        .update(plainText, 'latin1')
        .digest('hex')
        .toUpperCase();
    
    console.log('[Hash-Step2] SHA512 Result:', hash);
    return hash;
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
    email = 'test@example.com'
}) {
    console.log('\n' + '='.repeat(60));
    console.log('GARANTI OOS_PAY PAYMENT REQUEST');
    console.log('='.repeat(60));
    console.log('Order ID:', orderId);
    console.log('Amount (kuruş):', amountMinor);
    console.log('Currency:', currency);
    console.log('Customer IP:', customerIp);
    
    // 1. Secret'ları Çek
    const [rawTerminalId, storeNo, password, rawStoreKey] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),
        getSecret('GARANTI_STORE_NO'),
        getSecret('GARANTI_TERMINAL_PASSWORD'), 
        getSecret('GARANTI_ENC_KEY')            
    ]);

    if (!rawTerminalId || !rawStoreKey || !password) {
        throw new Error('❌ Garanti Secrets eksik!');
    }

    console.log('\n[Secrets Loaded]');
    console.log('  Terminal ID:', rawTerminalId);
    console.log('  Store No:', storeNo);
    console.log('  Password:', `***${password.length} chars***`);
    console.log('  Store Key:', `***${rawStoreKey.length} chars***`);

    // 2. Terminal ID - Garanti'den geldiği gibi kullan
    // Eğer 8 haneyse 8 hane, 9 haneyse 9 hane olarak kalsın
    const terminalIdRaw = clean(rawTerminalId);
    const terminalId = terminalIdRaw; // Olduğu gibi kullan
    
    const storeKey = clean(rawStoreKey);
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : clean(currency);
    const amount = String(amountMinor); // Kuruş cinsinden (örn: 10000 = 100.00 TL)

    // TAKSİT AYARI - KRİTİK!
    // Garanti bazı durumlarda boş installment kabul etmiyor
    // Peşin ödeme için "1" veya "" gönder
    let installmentStr = String(installments || '').trim();
    // Boş ise "1" ata (peşin ödeme)
    if (installmentStr === '0' || installmentStr === '') {
        installmentStr = '1';
    }

    const type = txnType || 'sales';

    console.log('\n[Processed Values]');
    console.log('  Terminal ID (as-is):', terminalId, `(${terminalId.length} digits)`);
    console.log('  Store No:', storeNo);
    console.log('  Currency Code:', currencyCode);
    console.log('  Amount (kuruş):', amount);
    console.log('  Installment:', installmentStr === '' ? '(empty - peşin)' : installmentStr);
    console.log('  Type:', type);

    // 3. Hash Hesaplama
    // NOT: Şifre hashinde 9 haneli ID kullanılır, ana hashde ise olduğu gibi
    const hashedPassword = createHashedPassword(clean(password), terminalId);
    
    const securityHash = createSecure3DHash({
        terminalId: terminalId,      // Olduğu gibi (8 veya 9 hane)
        orderId: orderId,
        amount: amount,
        currency: currencyCode,
        okUrl: okUrl,
        failUrl: failUrl,
        txnType: type,
        installment: installmentStr, // Boş olabilir
        storeKey: storeKey,
        hashedPassword: hashedPassword // 9 haneli ID ile üretilmiş
    });

    // 4. Banka URL  
    // NOT: OOS_PAY için gt3dengine endpoint kullanılıyor
    // VPServlet XML API içindir, gt3dengine HTML form POST içindir
    const actionUrl = 'https://sanalposprovtest.garantibbva.com.tr/servlet/gt3dengine';

    // 5. Form Alanları
    // ÖNEMLI: Garanti'nin beklediği EXACT field name'ler
    const formFields = {
        // Sistem alanları
        mode: 'TEST',
        apiversion: '512',
        secure3dsecuritylevel: '3D_OOS_FULL', // Ortak Ödeme Sayfası
        
        // Kullanıcı bilgileri
        terminalprovuserid: 'PROVAUT',
        terminaluserid: 'PROVAUT',
        terminalmerchantid: clean(storeNo),
        terminalid: terminalId, // 8 veya 9 haneli, olduğu gibi
        
        // İşlem bilgileri
        txntype: type,
        txnamount: amount,
        txncurrencycode: currencyCode,
        txninstallmentcount: installmentStr, // Boş olabilir
        orderid: orderId,
        
        // URL'ler
        successurl: okUrl,
        errorurl: failUrl,
        
        // Müşteri bilgileri
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        
        // Güvenlik
        secure3dhash: securityHash,
        
        // Opsiyonel
        lang: 'tr',
        refreshtime: '10'
    };

    console.log('\n[Form Fields to Bank]');
    console.log('='.repeat(60));
    Object.entries(formFields).forEach(([key, value]) => {
        const displayValue = key === 'secure3dhash' 
            ? `${value.substring(0, 20)}...` 
            : value;
        console.log(`${key.padEnd(25)} = ${displayValue}`);
    });
    console.log('='.repeat(60));
    console.log('✅ Payment form ready');
    console.log('='.repeat(60) + '\n');

    return { actionUrl, formFields };
}

/**
 * Callback Hash Doğrulama
 */
export async function verifyCallbackHash(postBody) {
    try {
        console.log('\n' + '='.repeat(60));
        console.log('GARANTI CALLBACK VERIFICATION');
        console.log('='.repeat(60));
        
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const storeKey = clean(rawStoreKey);

        const getParam = (key) => {
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === key.toLowerCase());
            return foundKey ? postBody[foundKey] : null;
        };

        // Kritik alanları kontrol et
        const mdStatus = getParam('mdstatus');
        const procReturnCode = getParam('procreturncode');
        const mdErrorMsg = getParam('mderrormessage');
        const errMsg = getParam('errmsg');

        console.log('[Bank Response]');
        console.log('  MD Status:', mdStatus);
        console.log('  Proc Return Code:', procReturnCode);
        console.log('  MD Error Msg:', mdErrorMsg || '(none)');
        console.log('  Error Msg:', errMsg || '(none)');

        const responseHash = getParam('hash') || getParam('secure3dhash');
        const hashParams = getParam('hashparams');

        console.log('  Response Hash:', responseHash ? '✓ Present' : '✗ MISSING');
        console.log('  Hash Params:', hashParams || '✗ MISSING');

        if (!responseHash || !hashParams) {
            console.log('\n⚠️ Hash verification SKIPPED');
            console.log('Reason: Bank rejected transaction BEFORE completing 3D auth');
            console.log('This means there was a problem with the initial request.');
            console.log('Common causes:');
            console.log('  1. Incorrect credentials (Terminal ID, Password, Store Key)');
            console.log('  2. Invalid field format (Amount, Installment, etc.)');
            console.log('  3. Hash mismatch in initial request');
            console.log('  4. Test account not properly configured for OOS_PAY');
            console.log('='.repeat(60) + '\n');
            return false;
        }

        // Hash doğrulama
        const paramList = String(hashParams).split(':');
        let digestData = '';
        
        console.log('\n[Hash Verification]');
        console.log('Hash Params Order:', hashParams);
        console.log('Building hash from:');
        
        for (const param of paramList) {
            if (!param) continue;
            const val = getParam(param);
            if (val !== null && val !== undefined) {
                console.log(`  ${param}: ${val}`);
                digestData += val;
            }
        }
        
        digestData += storeKey;
        console.log(`  storekey: ***${storeKey.length} chars***`);

        const calculatedHash = crypto.createHash('sha512')
            .update(digestData, 'latin1')
            .digest('hex')
            .toUpperCase();

        const isValid = (responseHash.toUpperCase() === calculatedHash);
        
        if (!isValid) {
            console.log('\n❌ HASH MISMATCH');
            console.log('Expected:', calculatedHash);
            console.log('Received:', responseHash.toUpperCase());
        } else {
            console.log('\n✅ Hash Valid');
        }

        console.log('='.repeat(60) + '\n');
        return isValid;

    } catch (e) {
        console.error('❌ Verify Error:', e);
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

    console.log('\n[Approval Check]');
    console.log('  MD Status:', mdStatus);
    console.log('  Proc Return Code:', procReturnCode);
    console.log('  Response:', response || '(empty)');

    // MD Status değerleri:
    // 1,2,3,4 = Başarılı
    // 5,6,7,8,0 = Başarısız
    const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
    const procOk = String(procReturnCode) === '00' || String(response).toLowerCase() === 'approved';

    const approved = mdOk && procOk;
    console.log('  Result:', approved ? '✅ APPROVED' : '❌ REJECTED');

    return approved;
}