// payment-provider/Garanti/Garanti-config.js

export function getConfig() {
    return {
        title: 'Garanti BBVA Sanal POS',

        paymentMethods: [{
            hostedPage: {
                // title: 'Hizmet Geçici olarak kullanılmamaktadır', // --- ESKİ ---
                title: 'Servis geçici olarak hizmet dışıdır.', // +++ YENİ +++

                logos: {
                    // **Beyaz (White) Logo** - Karanlık temalara uygun
                    white: {
                        // Gerçek Garanti BBVA logosu URL'si ile değiştirin!
                        svg: 'https://www.garantibbva.com.tr/content/experience-fragments/public-website/tr/site/header/master1/_jcr_content/root/header/headerdesktop/image.coreimg.svg/1699885476212/logo.svg',
                        png: 'https://www.garantibbva.com.tr/content/experience-fragments/public-website/tr/site/header/master1/_jcr_content/root/header/headerdesktop/image.coreimg.svg/1699885476212/logo.svg'
                    },
                    // **Renkli (Colored) Logo** - Aydınlık temalara uygun
                    colored: {
                        // Gerçek Garanti BBVA logosu URL'si ile değiştirin!
                        svg: 'https://www.garantibbva.com.tr/content/experience-fragments/public-website/tr/site/header/master1/_jcr_content/root/header/headerdesktop/image.coreimg.svg/1699885476212/logo.svg',
                        png: 'https://www.garantibbva.com.tr/content/experience-fragments/public-website/tr/site/header/master1/_jcr_content/root/header/headerdesktop/image.coreimg.svg/1699885476212/logo.svg'
                    }
                }
            }
        }],

        credentialsFields: [{
            simpleField: {
                name: 'callbackBaseUrl',
                label: 'Callback Base URL (Örn: https://www.tamyogastudio.com)'
            }
        }]
    };
}