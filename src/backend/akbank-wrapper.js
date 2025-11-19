// backend/akbank-wrapper.js

import { getSecret } from 'wix-secrets-backend';
import crypto from 'crypto';

/** SHA512 -> Base64 (NestPay ver3) */
export async function buildFormHash({ clientId, orderId, amountMajor, okUrl, failUrl, txnType, installments, rnd, storeKey }) {
  const plain = `${clientId}${orderId}${amountMajor}${okUrl}${failUrl}${txnType}${installments}${rnd}${storeKey}`;
  const digest = crypto.createHash('sha512').update(plain, 'utf8').digest();
  return Buffer.from(digest).toString('base64');
}

/** Base host -> doğru est3Dgate path (Akbank dağıtım varyantları) */
function resolveEst3DUrl(gatewayBase) {
  const base = String(gatewayBase || '').replace(/\/+$/, '');
  if (!base) throw new Error('missing gateway base');
  // sanalposest3.* -> /servlet/est3Dgate, geri kalan -> /fim/est3Dgate
  const useServlet = /sanalposest3/i.test(base) || /\/servlet\b/i.test(base);
  return `${base}${useServlet ? '/servlet/est3Dgate' : '/fim/est3Dgate'}`;
}

/**
 * PayHosting formu (minimum zorunlu set)
 * Varsayılan storetype: '3d_hosting'
 * - Gerekirse çağrıda storetypeOverride: '3d_pay_hosting' geçebilirsin.
 */
export async function buildPayHostingForm({
  orderId,
  amountMinor,
  currency = '949', // 949=TRY, 840=USD, 978=EUR
  okUrl,
  failUrl,
  installments = '', // tek çekim: ''
  txnType = 'Auth',
  storetypeOverride, // opsiyonel: '3d_pay_hosting'
  gatewayBaseOverride // opsiyonel: test/prod base override
}) {
  // Zorunlu secret'lar
  const clientId = await getSecret('AKBANK_CLIENT_ID');
  const storeKey = await getSecret('AKBANK_STORE_KEY');
  const gatewayBase = gatewayBaseOverride || await getSecret('AKBANK_GATEWAY_BASE');
  if (!clientId || !storeKey || !gatewayBase) throw new Error('missing akbank secrets');

  // Tutar: minor -> "12.34"
  if (!(Number(amountMinor) > 0)) throw new Error('amount must be > 0');
  const amountMajor = (parseInt(String(amountMinor), 10) / 100).toFixed(2);

  // Hash
  const rnd = String(Date.now());
  const hash = await buildFormHash({
    clientId, orderId, amountMajor, okUrl, failUrl, txnType, installments, rnd, storeKey
  });

  const actionUrl = resolveEst3DUrl(gatewayBase);

  // *** Minimum zorunlu alanlar ***
  const formFields = {
    clientid: clientId,
    oid: orderId,
    amount: amountMajor,
    currency, // ISO numeric
    okUrl,
    failUrl,
    rnd,
    hash,
    storetype: storetypeOverride || '3d_hosting', // default
    islemtipi: txnType // 'Auth'
  };

  if (installments) formFields.taksit = String(installments);

  return { actionUrl, formFields };
}

/** Callback hash doğrulama (yaygın NestPay şeması) */
export async function verifyCallbackHash(postBody) {
  const storeKey = await getSecret('AKBANK_STORE_KEY');
  const plain = `${postBody.clientid || ''}${postBody.oid || ''}${postBody.AuthCode || ''}${postBody.ProcReturnCode || ''}${postBody.MDStatus || ''}${postBody.amount || ''}${postBody.Currency || postBody.currency || ''}${postBody.rnd || postBody.Rnd || ''}${storeKey}`;
  const expected = Buffer.from(crypto.createHash('sha512').update(plain, 'utf8').digest()).toString('base64');
  const got = postBody.Hash || postBody.hash || '';
  return expected === got;
}

/** Başarı: MDStatus 1-4 ve ProcReturnCode "00" */
export function isApproved(postBody) {
  const mdOk = ['1', '2', '3', '4'].includes(String(postBody.MDStatus || ''));
  const prcOk = String(postBody.ProcReturnCode || '') === '00' || String(postBody.Response || '').toLowerCase() === 'approved';
  return mdOk && prcOk;
}
