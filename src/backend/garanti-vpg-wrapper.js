import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

function clean(val) {
    return String(val || '').trim();
}

/**
 * [ADIM 1] Şifre Hashleme (SHA1)
 * KRITIK: Terminal ID'yi 9 haneye tamamla
 */
function createHashedPassword(password, terminalId) {
    const paddedId = terminalId.padStart(9, '0'); 
    const rawData = password + paddedId;
    
    console.log('[Hash-Step1] Terminal ID (raw):', terminalId);
    console.log('[Hash-Step1] Terminal ID (padded to 9):', paddedId);
    console.log('[Hash-Step1] Password length:', password.length);

    // SHA1 hash - ISO-8859-9 (Turkish) encoding için latin1 kullanıyoruz
    const hash = crypto.createHash('sha1')
        .update(rawData, 'latin1')
        .digest('hex')
        .toUpperCase();
    
    console.log('[Hash-Step1] SHA1 Result:', hash);
    return hash;
}

/**
 * [ADIM 2] Güvenlik Hash'i (SHA512)
 * 3D_OOS_FULL için hash hesaplama
 */
function createSecure3DHash(data) {
    // Garanti'nin beklediği EXACT sıra (3D_OOS_FULL için):
    const plainText = 
        data.terminalId +      // Terminal ID (9 haneli)
        data.orderId + 
        data.amount + 
        data.okUrl + 
        data.failUrl + 
        data.txnType + 
        data.installment +     // Boş olabilir ama field olmalı
        data.storeKey + 
        data.hashedPassword;   // SHA1 ile hashlenmiş şifre

    console.log('[Hash-Step2] Hash String Components:');
    console.log('  1. TerminalID:', data.terminalId, `(${data.terminalId.length} chars)`);
    console.log('  2. OrderID:', data.orderId);
    console.log('  3. Amount:', data.amount);
    console.log('  4. OkURL:', data.okUrl);
    console.log('  5. FailURL:', data.failUrl);
    console.log('  6. TxnType:', data.txnType);
    console.log('  7. Installment:', `"${data.installment}"`);
    console.log('  8. StoreKey:', `***${data.storeKey.length}***`);
    console.log('  9. HashedPwd:', data.hashedPassword);
    
    console.log('[Hash-Step2] Full String Length:', plainText.length);

    // SHA512 hash - ISO-8859-9 encoding için latin1
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
    console.log('GARANTI 3D_OOS_FULL PAYMENT REQUEST - PRODUCTION');
    console.log('='.repeat(60));
    console.log('Order ID:', orderId);
    console.log('Amount (kuruş):', amountMinor);
    console.log('Currency:', currency);
    console.log('Customer IP:', customerIp);
    
    // 1. Secret'ları Çek - CANLI SİSTEM
    const [rawTerminalId, merchantId, userId, provUserId, password, rawStoreKey] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),      // 10380183
        getSecret('GARANTI_MERCHANT_ID'),      // 3066677
        getSecret('GARANTI_USER_ID'),          // PROVOOS
        getSecret('GARANTI_PROV_USER_ID'),     // PROVOOS
        getSecret('GARANTI_TERMINAL_PASSWORD'), // Gvp+2024Pos
        getSecret('GARANTI_ENC_KEY')           // GvP2024TamYogaSecureKy9x
    ]);

    if (!rawTerminalId || !rawStoreKey || !password || !merchantId) {
        throw new Error('❌ Garanti CANLI sistem secret\'ları eksik!');
    }

    console.log('\n[Secrets Loaded - PRODUCTION]');
    console.log('  Terminal ID:', rawTerminalId);
    console.log('  Merchant ID:', merchantId);
    console.log('  User ID:', userId || 'PROVOOS');
    console.log('  Prov User ID:', provUserId || 'PROVOOS');
    console.log('  Password:', `***${password.length} chars***`);
    console.log('  Store Key:', `***${rawStoreKey.length} chars*** (should be 24)`);

    // Store Key kontrolü - 24 karakter olmalı
    if (rawStoreKey.length !== 24) {
        console.warn('⚠️ Store Key 24 karakter değil! Length:', rawStoreKey.length);
    }

    // 2. Terminal ID - 9 haneye tamamla
    const terminalId = clean(rawTerminalId).padStart(9, '0');
    const storeKey = clean(rawStoreKey);
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : clean(currency);
    const amount = String(amountMinor); // Kuruş cinsinden (örn: 10000 = 100.00 TL)

    // TAKSİT AYARI
    // Peşin ödeme için boş string veya "1" deneyelim
    let installmentStr = String(installments || '').trim();
    if (installmentStr === '0' || installmentStr === '') {
        installmentStr = ''; // Önce boş dene, çalışmazsa "1" yapacağız
    }

    const type = txnType || 'sales';

    console.log('\n[Processed Values]');
    console.log('  Terminal ID (padded):', terminalId, `(${terminalId.length} digits)`);
    console.log('  Merchant ID:', merchantId);
    console.log('  Currency Code:', currencyCode);
    console.log('  Amount (kuruş):', amount);
    console.log('  Installment:', installmentStr === '' ? '(empty - peşin)' : installmentStr);
    console.log('  Type:', type);

    // 3. Hash Hesaplama
    const hashedPassword = createHashedPassword(clean(password), terminalId);
    
    const securityHash = createSecure3DHash({
        terminalId: terminalId,      // 9 haneli
        orderId: orderId,
        amount: amount,
        okUrl: okUrl,
        failUrl: failUrl,
        txnType: type,
        installment: installmentStr, // Boş olabilir
        storeKey: storeKey,
        hashedPassword: hashedPassword
    });

    // 4. CANLI URL
    const actionUrl = 'https://sanalposprov.garanti.com.tr/servlet/gt3dengine';
    console.log('  🔴 PRODUCTION URL:', actionUrl);

    // 5. Form Alanları - 3D_OOS_FULL için
    const formFields = {
        // Sistem alanları - CANLI sistemde MODE yok
        apiversion: '512',
        secure3dsecuritylevel: '3D_OOS_FULL',
        
        // Terminal bilgileri
        terminalid: terminalId,
        terminalmerchantid: clean(merchantId),
        terminaluserid: clean(userId || 'PROVOOS'),
        terminalprovuserid: clean(provUserId || 'PROVOOS'),
        
        // İşlem bilgileri
        txntype: type,
        txnamount: amount,
        txncurrencycode: currencyCode,
        txninstallmentcount: installmentStr,
        orderid: orderId,
        
        // URL'ler
        successurl: okUrl,
        errorurl: failUrl,
        
        // Müşteri bilgileri
        customeripaddress: customerIp || '127.0.0.1',
        customeremailaddress: email,
        
        // Güvenlik
        secure3dhash: securityHash,
        
        // Dil ve zamanlama
        lang: 'tr',
        refreshtime: '10',
        
        // Timestamp
        txntimestamp: Date.now().toString()
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
    console.log('✅ Payment form ready for PRODUCTION 3D_OOS_FULL');
    console.log('='.repeat(60) + '\n');

    return { actionUrl, formFields };
}

/**
 * Callback Hash Doğrulama
 */
export async function verifyCallbackHash(postBody) {
    try {
        console.log('\n' + '='.repeat(60));
        console.log('GARANTI 3D_OOS_FULL CALLBACK VERIFICATION - PRODUCTION');
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
        const response = getParam('response');

        console.log('[Bank Response - PRODUCTION]');
        console.log('  MD Status:', mdStatus);
        console.log('  Proc Return Code:', procReturnCode);
        console.log('  Response:', response);
        console.log('  MD Error Msg:', mdErrorMsg || '(none)');
        console.log('  Error Msg:', errMsg || '(none)');

        const responseHash = getParam('hash');
        const hashParams = getParam('hashparams');
        const hashParamsVal = getParam('hashparamsval');

        console.log('  Response Hash:', responseHash ? '✓ Present' : '✗ MISSING');
        console.log('  Hash Params:', hashParams || '✗ MISSING');
        console.log('  Hash Params Val:', hashParamsVal ? '✓ Present' : '✗ MISSING');

        if (!responseHash || !hashParams) {
            console.log('\n⚠️ Hash verification SKIPPED');
            console.log('Reason: Missing hash parameters');
            
            // MD Status 7 veya 0 ise işlem başarısız
            if (mdStatus === '7' || mdStatus === '0') {
                console.log('Transaction rejected by bank (MD Status:', mdStatus, ')');
                console.log('This usually means authentication/configuration error');
            }
            
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
            .update(digestData, 'latin1')  // ISO-8859-9 encoding
            .digest('hex')
            .toUpperCase();

        const isValid = (responseHash.toUpperCase() === calculatedHash);
        
        if (!isValid) {
            console.log('\n❌ HASH MISMATCH');
            console.log('Expected:', calculatedHash.substring(0, 20) + '...');
            console.log('Received:', responseHash.toUpperCase().substring(0, 20) + '...');
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
    const authCode = getParam('authcode');
    const hostRefNum = getParam('hostrefnum');

    console.log('\n[Approval Check]');
    console.log('  MD Status:', mdStatus);
    console.log('  Proc Return Code:', procReturnCode);
    console.log('  Response:', response || '(empty)');
    console.log('  Auth Code:', authCode || '(empty)');
    console.log('  Host Ref Num:', hostRefNum || '(empty)');

    // MD Status değerleri:
    // 1,2,3,4 = Başarılı
    // 5,6,7,8,0 = Başarısız
    const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
    const procOk = String(procReturnCode) === '00';
    const responseOk = String(response).toLowerCase() === 'approved';

    // 3D_OOS_FULL için authCode ve hostRefNum kontrolü de ekleyelim
    const hasAuthCode = authCode && authCode.length > 0;
    const hasHostRef = hostRefNum && hostRefNum.length > 0;

    const approved = mdOk && procOk && (responseOk || (hasAuthCode && hasHostRef));
    
    console.log('  Result:', approved ? '✅ APPROVED' : '❌ REJECTED');

    return approved;
}