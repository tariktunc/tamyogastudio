// payment-provider/Akbank/Akbank-config.js

export function getConfig() {
  return {
    title: 'Akbank Sanal POS',
    paymentMethods: [
      {
        hostedPage: {
          title: 'Kredi kartı ile ödeme (Tüm kartlar)',
          // billingAddressMandatoryFields: ['CITY'],
          logos: {
            white: {
              svg: 'https://static.wixstatic.com/shapes/1626b5_23975221b52a4e2280a8c726d08aca52.svg',
              png: 'https://static.wixstatic.com/media/1626b5_634c1827e0bf41629c1dcd8c8d901b7a~mv2.png'
            },
            colored: {
              svg: 'https://static.wixstatic.com/shapes/1626b5_23975221b52a4e2280a8c726d08aca52.svg',
              png: 'https://static.wixstatic.com/media/1626b5_634c1827e0bf41629c1dcd8c8d901b7a~mv2.png'
            }
          }
        }
      }
    ],
    credentialsFields: [
      {
        simpleField: {
          name: 'callbackBaseUrl',
          label: 'Callback Base URL (https://tamyogastudio.com)'
        }
      }
      // Diğer gizliler (CLIENT_ID, STORE_KEY, GATEWAY_BASE)
      // Secrets Manager’da tutulur:
      // AKBANK_CLIENT_ID, AKBANK_STORE_KEY, AKBANK_GATEWAY_BASE
    ]
  };
}
