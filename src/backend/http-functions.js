// backend/http-functions.js
import { ok } from 'wix-http-functions';
import { PAY_CSS } from 'public/pay-css.js';

// Service imports
import * as AkbankService from 'backend/akbank-service';
import * as GarantiService from 'backend/garanti-service';

// ===============================
// CSS endpoint (pay modal styles)
// ===============================
export function get_paycss() {
  return ok({
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=86400'
    },
    body: PAY_CSS
  });
}

// ===============================
// AKBANK ROUTES
// ===============================
export function get_payRedirect(request) {
  return AkbankService.redirect(request);
}

export function post_akbankCallback(request) {
  return AkbankService.callback(request);
}

export function get_akbankCallback(request) {
  return AkbankService.callback(request);
}

// ===============================
// GARANTI ROUTES
// ===============================
export function get_garantiRedirect(request) {
  return GarantiService.redirect(request);
}

export function post_garantiCallback(request) {
  return GarantiService.callback(request);
}

export function get_garantiCallback(request) {
  return GarantiService.callback(request);
}