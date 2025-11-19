// src/public/pay-css.js
// HTTP Function tarafından "text/css" olarak yayınlanır.
// -- ÖZET (HTTP’de verilen id/class referansı) ---------------------------------
// Genel: #akb-body, #akb-wrap
// Seçim ekranı: #akb-card-selection, #akb-title-selection, #akb-form-select,
//               #akb-row-amount, #akb-amount, #akb-row-install, #akb-install,
//               #akb-actions-select, #akb-select-submit, #akb-select-cancel
// Onay ekranı:  #akb-card-confirm, #akb-title-confirm, #akb-row-amount-confirm,
//               #akb-amount-confirm, #akb-row-install-confirm, #akb-install-chosen,
//               #akb-row-monthly, #akb-monthly, #akb-note,
//               #akb-actions-confirm, #akb-confirm-cancel, #akb-form, #akb-submit
// Callback:     #akb-card-alert, #akb-close-title
// Sınıflar:     .wrap, .card, .row, .label, .amount, .select, .actions,
//               .btn, .btn-primary, .note
// ------------------------------------------------------------------------------
export const PAY_CSS = `
/* =================== Akbank Pay – Sade, Erişilebilir, Responsive =================== */
:root{
  color-scheme: light;
  --page-bg: #F5F4F6;               /* İstenen sayfa arka planı */
  --surface: #FFFFFF;               /* Kart ve yüzeyler beyaz */
  --fg: #7c0c1bff;                    /* Ana metin */
  --muted: #6B7280;                 /* İkincil metin */
  --line: #E6E7EB;                  /* Sınır çizgileri */

  --brand: #DC0005;                 /* Buton ve vurgu rengi */
  --ink-on-brand: #FFFFFF;          /* Buton metni */
  --radius-lg: 14px;
  --radius: 12px;
  --radius-sm: 10px;
  --focus-ring: 0 0 0 3px rgba(224, 36, 39, 0.28); /* erişilebilir odak */
  --gap: 1rem; --gap-sm: .75rem; --gap-lg: 1.25rem;
  --font: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
}

*{box-sizing:border-box}
html,body{height:100%}
body#akb-body{
  margin:0;
  background: var(--page-bg);       /* Talep edilen arka plan */
  color: var(--fg);
  font:16px/1.45 var(--font);
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
}

/* Konteyner ve kart */
.wrap{
  max-width: 880px;
  margin: 0 auto;
  padding: clamp(16px, 3vw, 28px) clamp(16px, 3vw, 28px) clamp(24px, 4vw, 40px);
}
.card{
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: clamp(16px, 2.5vw, 24px);
}

/* Başlıklar ve metin */
h1,h2{margin:0 0 .75rem 0; line-height:1.2}
h1{font-size: clamp(20px, 3.2vw, 26px); font-weight:800; letter-spacing:.2px}
h2{font-size: clamp(18px, 3vw, 22px); font-weight:700}
p{margin:.5rem 0 0 0; color:var(--muted)}

/* Form ve satırlar */
form{margin:0}
.row{
  display:grid;
  grid-template-columns: 1fr;
  gap: var(--gap-sm);
  align-items:center;
  margin-bottom: var(--gap);
}
.label{font-weight:600; color:var(--muted)}
.amount{
  font-weight:800; letter-spacing:.2px; font-variant-numeric: tabular-nums;
  color: var(--brand);
}

/* Alanlar */
select, .select, input[type="text"], input[type="number"], input[type="tel"]{
  width:100%;
  appearance:none; -webkit-appearance:none;
  background: var(--surface);
  color: var(--fg);
  border:1px solid var(--line);
  border-radius: var(--radius-sm);
  padding:.7rem .9rem;
  line-height:1.2;
  /* Hover/animasyon yok → transition uygulanmıyor */
}
select:focus, .select:focus,
input[type="text"]:focus, input[type="number"]:focus, input[type="tel"]:focus{
  outline:2px solid transparent;
  border-color: var(--brand);
  box-shadow: var(--focus-ring);
}

/* Select ok simgesi (statik) */
select, .select{
  background-image:
    linear-gradient(45deg, transparent 50%, var(--muted) 50%),
    linear-gradient(135deg, var(--muted) 50%, transparent 50%),
    linear-gradient(to right, transparent, transparent);
  background-position:
     calc(100% - 18px) calc(1.05em + 2px),
     calc(100% - 13px) calc(1.05em + 2px),
     100% 0;
  background-size: 5px 5px, 5px 5px, 2.5em 2.5em;
  background-repeat:no-repeat;
  padding-right: 2.4rem;
}

/* Aksiyon alanı */
.actions{ display:flex; gap: var(--gap-sm); flex-wrap: wrap; margin-top: var(--gap-lg); justify-content:flex-end }

/* Butonlar – hover/animasyon YOK; erişilebilir odak VAR */
.btn{
  display:inline-flex; align-items:center; justify-content:center; gap:.5rem;
  padding:.85rem 1.2rem;
  border:1px solid var(--line);
  border-radius: 999px;
  background:#FFFFFF;
  color: var(--fg);
  text-decoration:none; cursor:pointer; min-width: 140px;
}
.btn:focus-visible{outline:2px solid transparent; box-shadow: var(--focus-ring)}
.btn[disabled]{opacity:.6; cursor:not-allowed}

/* Birincil CTA */
.btn-primary{
  background: var(--brand);
  color: var(--ink-on-brand);
  border-color: var(--brand);
  font-weight:800;
}

/* Açıklama blokları */
.note{color:var(--muted); font-size:.95rem}
pre.note{ background:transparent; border:1px dashed var(--line); padding:.75rem; border-radius:var(--radius-sm); overflow:auto }

/* Izgara – geniş ekranda iki kolon etiket/değer */
@media (min-width:560px){ .row{ grid-template-columns: 240px 1fr } }

/* Konteyner optimizasyonları */
@media (min-width:960px){ .wrap{ max-width: 980px } }
`;
