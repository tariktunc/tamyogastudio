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
 * GARANTİ DOKÜMANI: password + "0" + terminalId
 * NOT: Terminal ID'nin başına "0" ekleniyor, 9 haneye tamamlama yok!
 */
function createHashedPassword(password, terminalId) {
    // GARANTİ'NİN FORMÜLÜ: password + "0" + terminalId
    const rawData = password + "0" + terminalId;
    
    console.log('[Hash-Step1] Password:', `***${password.length} chars***`);
    console.log('[Hash-Step1] Formula: password + "0" + terminalId');
    console.log('[Hash-Step1] Terminal ID:', terminalId);

    // ISO-8859-9 (Turkish) encoding
    const hash = crypto.createHash('sha1')
        .update(rawData, 'latin1')  // latin1 = ISO-8859-1/9
        .digest('hex')
        .toUpperCase();
    
    console.log('[Hash-Step1] SHA1 Result:', hash);
    return hash;
}

/**
 * [ADIM 2] Güvenlik Hash'i (SHA512)
 * GARANTİ DOKÜMANI: terminalId + orderId + amount + currencyCode + successUrl + errorUrl + type + installmentCount + storeKey + hashedPassword
 */
function createSecure3DHash(data) {
    // GARANTİ'NİN RESMİ SIRASI:
    const plainText = 
        data.terminalId +      // Terminal ID (olduğu gibi)
        data.orderId + 
        data.amount + 
        data.currencyCode +    // CURRENCY CODE BURADA!
        data.successUrl +      // Success URL
        data.errorUrl +        // Error URL
        data.txnType +         // Type (sales)
        data.installment +     // Installment (peşin için boş)
        data.storeKey + 
        data.hashedPassword;

    console.log('[Hash-Step2] Hash String Components:');
    console.log('  1. TerminalID:', data.terminalId);
    console.log('  2. OrderID:', data.orderId);
    console.log('  3. Amount:', data.amount);
    console.log('  4. CurrencyCode:', data.currencyCode);
    console.log('  5. SuccessURL:', data.successUrl);
    console.log('  6. ErrorURL:', data.errorUrl);
    console.log('  7. TxnType:', data.txnType);
    console.log('  8. InstallmentCount:', `"${data.installment}"`);
    console.log('  9. StoreKey:', `***${data.storeKey.length} chars***`);
    console.log(' 10. HashedPassword:', data.hashedPassword);
    
    console.log('[Hash-Step2] Full String Length:', plainText.length);

    // ISO-8859-9 encoding
    const hash = crypto.createHash('sha512')
        .update(plainText, 'latin1')  // latin1 = ISO-8859-1/9
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
    console.log('🔴 GARANTI OOS_PAY - PRODUCTION (FIXED VERSION)');
    console.log('='.repeat(60));
    console.log('Order ID:', orderId);
    console.log('Amount (kuruş):', amountMinor);
    console.log('Currency:', currency);
    console.log('Customer IP:', customerIp);
    
    // 1. Secret'ları Çek - CANLI SİSTEM
    const [rawTerminalId, merchantId, userId, provUserId, password, rawStoreKey] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),      // 10380183
        getSecret('GARANTI_MERCHANT_ID'),      // 3066677
        getSecret('GARANTI_USER_ID'),          // 37387651730
        getSecret('GARANTI_PROV_USER_ID'),     // PROVOOS
        getSecret('GARANTI_TERMINAL_PASSWORD'), // Gvp+2024Pos
        getSecret('GARANTI_ENC_KEY')           // HEX format
    ]);

    if (!rawTerminalId || !rawStoreKey || !password || !merchantId) {
        throw new Error('❌ Garanti CANLI sistem secret\'ları eksik!');
    }

    console.log('\n[Secrets Loaded - PRODUCTION]');
    console.log('  Terminal ID:', rawTerminalId);
    console.log('  Merchant ID:', merchantId);
    console.log('  User ID:', userId);
    console.log('  Prov User ID:', provUserId || 'PROVOOS');
    console.log('  Password:', `***${password.length} chars***`);
    console.log('  Store Key (raw):', `***${rawStoreKey.length} chars***`);

    // Store Key'i işle (HEX'ten TEXT'e çevir)
    const storeKey = processStoreKey(rawStoreKey);
    console.log('  Store Key (processed):', `***${storeKey.length} chars*** (should be 24)`);

    // 2. Terminal ID - OLDUĞU GİBİ KULLAN (9 haneye tamamlama YOK)
    const terminalId = clean(rawTerminalId); // 8 haneli kalacak: 10380183
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : clean(currency);
    const amount = String(amountMinor); // Kuruş cinsinden

    // TAKSİT AYARI - Peşin için BOŞ
    let installmentStr = '';
    const installmentInput = String(installments || '').trim();
    if (installmentInput === '0' || installmentInput === '1' || installmentInput === '') {
        installmentStr = ''; // PEŞİN = BOŞ STRING
    } else {
        installmentStr = installmentInput; // Taksitli
    }

    const type = txnType || 'sales';

    console.log('\n[Processed Values]');
    console.log('  Terminal ID:', terminalId, `(${terminalId.length} digits) - NO PADDING`);
    console.log('  Merchant ID:', merchantId);
    console.log('  Currency Code:', currencyCode);
    console.log('  Amount (kuruş):', amount);
    console.log('  Amount (TL):', (parseInt(amount) / 100).toFixed(2));
    console.log('  Installment:', installmentStr === '' ? 'EMPTY (Peşin)' : installmentStr);
    console.log('  Type:', type);

    // 3. Hash Hesaplama - GARANTİ DOKÜMANI FORMÜLÜ
    const hashedPassword = createHashedPassword(clean(password), terminalId);
    
    const securityHash = createSecure3DHash({
        terminalId: terminalId,      // Olduğu gibi (8 haneli)
        orderId: orderId,
        amount: amount,
        currencyCode: currencyCode,  // CURRENCY CODE EKLENDI!
        successUrl: okUrl,           // Doğru sırada
        errorUrl: failUrl,           // Doğru sırada
        txnType: type,
        installment: installmentStr,
        storeKey: storeKey,
        hashedPassword: hashedPassword
    });

    // 4. CANLI URL
    const actionUrl = 'https://sanalposprov.garanti.com.tr/servlet/gt3dengine';
    console.log('\n🔴 PRODUCTION URL:', actionUrl);

    // 5. Form Alanları - Terminal ID'yi 9 haneye tamamla (form için)
    const formTerminalId = terminalId.padStart(9, '0'); // Form için 9 haneli: 010380183
    
    const formFields = {
        // Sistem alanları
        apiversion: '512',
        secure3dsecuritylevel: '3D_OOS_FULL',  // 3D'li güvenli ödeme
        
        // Terminal bilgileri - 9 HANELİ
        terminalid: formTerminalId,  // 9 haneli: 010380183
        terminalmerchantid: clean(merchantId),
        terminaluserid: clean(userId),  // 37387651730
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
        
        // Opsiyonel
        lang: 'tr',
        refreshtime: '10',
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
    console.log('✅ Form ready - OFFICIAL DOCUMENTATION FORMULA');
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
        const storeKey = processStoreKey(rawStoreKey);

        const getParam = (key) => {
            const foundKey = Object.keys(postBody).find(k => k.toLowerCase() === key.toLowerCase());
            return foundKey ? postBody[foundKey] : null;
        };

        // Kritik alanları kontrol et
        const mdStatus = getParam('mdstatus');
        const procReturnCode = getParam('procreturncode');
        const response = getParam('response');

        console.log('[Bank Response]');
        console.log('  MD Status:', mdStatus);
        console.log('  Proc Return Code:', procReturnCode);
        console.log('  Response:', response);

        const responseHash = getParam('hash');
        const hashParams = getParam('hashparams');

        console.log('  Response Hash:', responseHash ? '✓ Present' : '✗ MISSING');
        console.log('  Hash Params:', hashParams || '✗ MISSING');

        if (!responseHash || !hashParams) {
            console.log('\n⚠️ Hash verification SKIPPED');
            return false;
        }

        // Hash doğrulama
        const paramList = String(hashParams).split(':');
        let digestData = '';
        
        console.log('\n[Hash Verification]');
        console.log('Hash Params Order:', hashParams);
        
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
            .update(digestData, 'latin1')  // ISO-8859-9
            .digest('hex')
            .toUpperCase();

        const isValid = (responseHash.toUpperCase() === calculatedHash);
        
        console.log(isValid ? '\n✅ Hash Valid' : '\n❌ Hash Mismatch');
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
    console.log('  Response:', response);

    // MD Status değerleri (döküman kontrolü yapılmadı, 3D için):
    // 1,2,3,4 = Başarılı
    // 5,6,7,8,0 = Başarısız
    const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
    const procOk = String(procReturnCode) === '00';
    const responseOk = String(response).toLowerCase() === 'approved';

    const approved = mdOk && procOk && responseOk;
    
    console.log('  Result:', approved ? '✅ APPROVED' : '❌ REJECTED');

    return approved;
}