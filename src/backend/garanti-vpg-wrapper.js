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
 * PHP KODUNA GÖRE: password + terminalId(9 haneli)
 * DİKKAT: "0" YOK! Sadece 9 haneye tamamlanmış terminal ID
 */
function createHashedPassword(password, terminalId) {
    // Terminal ID'yi 9 haneye tamamla
    const paddedTerminalId = terminalId.padStart(9, '0');
    
    // PHP: $password . str_pad((int)$terminalId, 9, 0, STR_PAD_LEFT)
    const rawData = password + paddedTerminalId; // "0" YOK!
    
    console.log('[Hash-Step1] Password:', `***${password.length} chars***`);
    console.log('[Hash-Step1] Terminal ID (9 haneli):', paddedTerminalId);
    console.log('[Hash-Step1] Formula: password + terminalId(9 haneli)');

    const hash = crypto.createHash('sha1')
        .update(rawData, 'latin1')  // ISO-8859-9
        .digest('hex')
        .toUpperCase();
    
    console.log('[Hash-Step1] SHA1 Result:', hash);
    return hash;
}

/**
 * [ADIM 2] Güvenlik Hash'i (SHA512)
 * PHP: terminalId . orderId . amount . currencyCode . successUrl . errorUrl . type . installmentCount . storeKey . hashedPassword
 */
function createSecure3DHash(data) {
    // Terminal ID 9 haneli olmalı
    const paddedTerminalId = data.terminalId.padStart(9, '0');
    
    // PHP koduna göre sıralama
    const plainText = 
        paddedTerminalId +     // 9 haneli terminal ID
        data.orderId + 
        data.amount + 
        data.currencyCode +
        data.successUrl +
        data.errorUrl +
        data.txnType +
        data.installment +     // Peşin için boş veya "0"
        data.storeKey + 
        data.hashedPassword;

    console.log('[Hash-Step2] Hash String Components:');
    console.log('  1. TerminalID (9 haneli):', paddedTerminalId);
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

    const hash = crypto.createHash('sha512')
        .update(plainText, 'latin1')  // ISO-8859-9
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
    console.log('🔴 GARANTI 3D_OOS_FULL - PHP CODE VERSION');
    console.log('='.repeat(60));
    console.log('Order ID:', orderId);
    console.log('Amount (kuruş):', amountMinor);
    console.log('Currency:', currency);
    console.log('Customer IP:', customerIp);
    
    // 1. Secret'ları Çek
    const [rawTerminalId, merchantId, userId, provUserId, password, rawStoreKey] = await Promise.all([
        getSecret('GARANTI_TERMINAL_ID'),      // 010380183 veya 10380183
        getSecret('GARANTI_MERCHANT_ID'),      // 3066677
        getSecret('GARANTI_USER_ID'),          // 37387651730
        getSecret('GARANTI_PROV_USER_ID'),     // PROVOOS
        getSecret('GARANTI_TERMINAL_PASSWORD'), // Gvp+2024Pos
        getSecret('GARANTI_ENC_KEY')           // HEX format
    ]);

    if (!rawTerminalId || !rawStoreKey || !password || !merchantId) {
        throw new Error('❌ Garanti secret\'ları eksik!');
    }

    console.log('\n[Secrets Loaded]');
    console.log('  Terminal ID (raw):', rawTerminalId);
    console.log('  Merchant ID:', merchantId);
    console.log('  User ID:', userId);
    console.log('  Prov User ID:', provUserId);

    // Store Key'i işle (HEX'ten TEXT'e çevir)
    const storeKey = processStoreKey(rawStoreKey);
    console.log('  Store Key (processed):', `***${storeKey.length} chars***`);

    // Terminal ID'yi temizle (0'lardan kurtul)
    const terminalId = clean(rawTerminalId).replace(/^0+/, ''); // 10380183
    const currencyCode = (currency === 'TRY' || currency === 'TL') ? '949' : clean(currency);
    const amount = String(amountMinor);

    // Taksit - PHP kodunda installmentCount = 0 görünüyor
    let installmentStr = '';
    if (installments === '' || installments === '0' || installments === '1') {
        installmentStr = ''; // Peşin için boş
    } else {
        installmentStr = installments;
    }

    const type = txnType || 'sales';

    console.log('\n[Processed Values]');
    console.log('  Terminal ID (cleaned):', terminalId);
    console.log('  Merchant ID:', merchantId);
    console.log('  Currency Code:', currencyCode);
    console.log('  Amount (kuruş):', amount);
    console.log('  Installment:', installmentStr === '' ? 'EMPTY' : installmentStr);
    console.log('  Type:', type);

    // 3. Hash Hesaplama - PHP koduna göre
    const hashedPassword = createHashedPassword(clean(password), terminalId);
    
    const securityHash = createSecure3DHash({
        terminalId: terminalId,
        orderId: orderId,
        amount: amount,
        currencyCode: currencyCode,
        successUrl: okUrl,
        errorUrl: failUrl,
        txnType: type,
        installment: installmentStr,
        storeKey: storeKey,
        hashedPassword: hashedPassword
    });

    // 4. URL
    const actionUrl = 'https://sanalposprov.garanti.com.tr/servlet/gt3dengine';
    console.log('\n🔴 PRODUCTION URL:', actionUrl);

    // 5. Form Alanları - Terminal ID 9 haneli olmalı
    const formTerminalId = terminalId.padStart(9, '0'); // 010380183
    
    const formFields = {
        // Sistem alanları - CANLI için MODE yok
        apiversion: '512',
        secure3dsecuritylevel: '3D_OOS_FULL',
        
        // Terminal bilgileri
        terminalid: formTerminalId,
        terminalmerchantid: clean(merchantId),
        terminaluserid: clean(userId),
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
        
        // Diğer
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
    console.log('✅ Form ready - PHP CODE FORMULA (NO "0")');
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
        
        for (const param of paramList) {
            if (!param) continue;
            const val = getParam(param);
            if (val !== null && val !== undefined) {
                digestData += val;
            }
        }
        
        digestData += storeKey;
        console.log(`  StoreKey added: ***${storeKey.length} chars***`);

        const calculatedHash = crypto.createHash('sha512')
            .update(digestData, 'latin1')
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

    console.log('\n[Approval Check]');
    console.log('  MD Status:', mdStatus);
    console.log('  Proc Return Code:', procReturnCode);

    const mdOk = ['1', '2', '3', '4'].includes(String(mdStatus));
    const procOk = String(procReturnCode) === '00';

    const approved = mdOk && procOk;
    
    console.log('  Result:', approved ? '✅ APPROVED' : '❌ REJECTED');

    return approved;
}