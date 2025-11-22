import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

function clean(val) {
    return String(val || '').trim();
}

/**
 * HEX Store Key'i TEXT'e çevirir
 */
function processStoreKey(rawStoreKey) {
    const cleaned = clean(rawStoreKey);
    
    // 48 karakter = HEX format (24 byte * 2)
    // 24 karakter = TEXT format
    if (cleaned.length === 48) {
        // HEX'ten TEXT'e çevir
        const textKey = Buffer.from(cleaned, 'hex').toString('utf8');
        console.log('  Store Key: HEX to TEXT conversion done');
        return textKey;
    } else if (cleaned.length === 24) {
        // Zaten TEXT formatında
        console.log('  Store Key: Already in TEXT format');
        return cleaned;
    } else {
        console.error('  Store Key: Unexpected length:', cleaned.length);
        return cleaned;
    }
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
        data.installment +     // Peşin için BOŞ
        data.storeKey + 
        data.hashedPassword;   // SHA1 ile hashlenmiş şifre

    console.log('[Hash-Step2] Hash String Components:');
    console.log('  1. TerminalID:', data.terminalId, `(${data.terminalId.length} chars)`);
    console.log('  2. OrderID:', data.orderId);
    console.log('  3. Amount:', data.amount);
    console.log('  4. OkURL:', data.okUrl);
    console.log('  5. FailURL:', data.failUrl);
    console.log('  6. TxnType:', data.txnType);
    console.log('  7. Installment:', `"${data.installment}" (${data.installment.length} chars)`);
    console.log('  8. StoreKey length:', data.storeKey.length);
    console.log('  9. HashedPwd:', data.hashedPassword);
    
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
    console.log('🔴 GARANTI 3D_OOS_FULL - PRODUCTION ENVIRONMENT');
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
        getSecret('GARANTI_ENC_KEY')           // HEX: 477650323...
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
    console.log('  Store Key (raw):', `***${rawStoreKey.length} chars***`);

    // Store Key'i işle (HEX'ten TEXT'e çevir)
    const storeKey = processStoreKey(rawStoreKey);
    console.log('  Store Key (processed):', `***${storeKey.length} chars*** (should be 24)`);

    // 2. Terminal ID - 9 haneye tamamla
    const terminalId = clean(rawTerminalId).padStart(9, '0');
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : clean(currency);
    const amount = String(amountMinor); // Kuruş cinsinden

    // TAKSİT AYARI - GARANTI DÖKÜMANI: Peşin için MUTLAKA BOŞ
    let installmentStr = '';
    const installmentInput = String(installments || '').trim();
    if (installmentInput === '0' || installmentInput === '1' || installmentInput === '') {
        installmentStr = ''; // PEŞİN = BOŞ STRING
    } else {
        installmentStr = installmentInput; // Taksitli
    }

    const type = txnType || 'sales';

    console.log('\n[Processed Values]');
    console.log('  Terminal ID (padded):', terminalId, `(${terminalId.length} digits)`);
    console.log('  Merchant ID:', merchantId);
    console.log('  Currency Code:', currencyCode);
    console.log('  Amount (kuruş):', amount);
    console.log('  Amount (TL):', (parseInt(amount) / 100).toFixed(2));
    console.log('  Installment:', installmentStr === '' ? 'EMPTY (Peşin)' : installmentStr);
    console.log('  Type:', type);

    // 3. Hash Hesaplama
    const hashedPassword = createHashedPassword(clean(password), terminalId);
    
    const securityHash = createSecure3DHash({
        terminalId: terminalId,      
        orderId: orderId,
        amount: amount,
        okUrl: okUrl,
        failUrl: failUrl,
        txnType: type,
        installment: installmentStr, // Peşin için boş
        storeKey: storeKey,          // TEXT formatında Store Key
        hashedPassword: hashedPassword
    });

    // 4. CANLI URL
    const actionUrl = 'https://sanalposprov.garanti.com.tr/servlet/gt3dengine';
    console.log('\n🔴 PRODUCTION URL:', actionUrl);

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
        txninstallmentcount: installmentStr,  // Peşin için BOŞ
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
    console.log('✅ Form ready with HEX Store Key support');
    console.log('='.repeat(60) + '\n');

    return { actionUrl, formFields };
}

/**
 * Callback Hash Doğrulama
 */
export async function verifyCallbackHash(postBody) {
    try {
        console.log('\n' + '='.repeat(60));
        console.log('GARANTI CALLBACK VERIFICATION - PRODUCTION');
        console.log('='.repeat(60));
        
        const rawStoreKey = await getSecret('GARANTI_ENC_KEY');
        const storeKey = processStoreKey(rawStoreKey); // HEX'ten TEXT'e çevir

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

        console.log('[Bank Response]');
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

        if (!responseHash || !hashParams) {
            console.log('\n⚠️ Hash verification SKIPPED - Missing parameters');
            
            if (mdStatus === '7' || mdStatus === '0') {
                console.log('❌ Transaction rejected (MD Status:', mdStatus, ')');
                console.log('Common causes:');
                console.log('  1. Store Key format mismatch');
                console.log('  2. Terminal configuration issue');
                console.log('  3. Hash calculation error');
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
        
        digestData += storeKey; // TEXT formatında Store Key
        console.log(`  storekey: ***${storeKey.length} chars***`);

        const calculatedHash = crypto.createHash('sha512')
            .update(digestData, 'latin1')
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

    const hasAuthCode = authCode && authCode.length > 0;
    const hasHostRef = hostRefNum && hostRefNum.length > 0;

    const approved = mdOk && procOk && (responseOk || (hasAuthCode && hasHostRef));
    
    console.log('  Result:', approved ? '✅ APPROVED' : '❌ REJECTED');

    return approved;
}