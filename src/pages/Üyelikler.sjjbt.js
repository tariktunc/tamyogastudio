import { customPurchaseFlow } from 'wix-pricing-plans-frontend';

$w('#tekSeansBTN').onClick((event) => {
    customPurchaseFlow.navigateToCheckout({
        planId: '5ae2887f-72df-4d6c-9e1c-eafb74da5950'
    });
})

$w('#hosGeldinBTN').onClick((event) => {
    customPurchaseFlow.navigateToCheckout({
        planId: '8a25f74a-2a19-4294-9501-de9927e9e0cc'
    });
})

$w('#1AyBTN').onClick((event) => {
    customPurchaseFlow.navigateToCheckout({
        planId: '58e42f49-51e8-4d65-96a7-c8fbeda5e943'
    });
})

$w('#3AyBTN').onClick((event) => {
    customPurchaseFlow.navigateToCheckout({
        planId: 'd76c0f33-3af2-4561-87ab-1732ac0af18d'
    });
})

$w('#6AyBTN').onClick((event) => {
    customPurchaseFlow.navigateToCheckout({
        planId: '21a44c81-951d-48e4-9ea9-4b563e7a2d84'
    });
})

$w('#12AyBTN').onClick((event) => {
    customPurchaseFlow.navigateToCheckout({
        planId: '485fbcf6-1e80-4261-a14d-a864fd09656a'
    });
})