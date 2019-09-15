const stripe = require("stripe")(process.env.STRIPE_API_KEY);

module.exports.getCatalog = async function (event) {
    let skus = await stripe.skus.list({
        "active": true,
        "expand": ["data.product"]
    });
    return {
        code: 200,
        body: skus.data
    };
}


module.exports.checkout = async function (event) {
    const skuInfo = JSON.parse(event.body);
    if(!skuInfo){
        return {
            code: 400,
            body: {
                code: "SH001"
            }
        };
    }

    let sku = await stripe.skus.retrieve(skuInfo.id);
    if(!sku.id){
        return {
            code: 404,
            body: {
                code: "SH002"
            }
        };
    }
    return {
        code: 200,
        body: {
            skuId: sku.id,
            price: sku.price
        }
    };
}

module.exports.createPayment = async function (event) {
    const mysql = event.mysql;

    const {
        token,
        skuId
    } = JSON.parse(event.body || {});
    if(!token || !skuId){
        return {
            code: 400,
            body: {
                code: "SH001"
            }
        };
    }
    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    if (!user.id) {
        return {
            code: 401,
            body: {
                code: "SH003"
            }
        };
    }

    //Verifico si el producto comprado existe
    let sku = await stripe.skus.retrieve(skuId);
    if(!sku.id){
        return {
            code: 404,
            body: {
                code: "SH002"
            }
        };
    }

    //Realizo el pago
    let paymentCreate = await stripe.paymentMethods.create({
        type: 'card',
        card: { token }
    });
    let payment = await stripe.paymentIntents.create({
        amount: sku.price,
        currency: sku.currency,
        payment_method: paymentCreate.id,
        payment_method_types: ['card'],
        confirm: true,
        return_url: process.env.SHOP_URL,
        metadata: {
            premiumDownloads: sku.attributes.Descargas
        }
    });

    //Obtengo el estado del pago
    if(payment.status === "succeeded"){
        await addPremiumDownload(mysql, user.id, payment.metadata.premiumDownloads);
    }

    return {
        code: 200,
        body: {
            status: payment.status, //succeeded,requires_action,requires_source
            url: payment.next_action != null ?  payment.next_action.redirect_to_url.url : null,
            premiumDownloads: payment.metadata.premiumDownloads,
            id: payment.id
        }
    };
}
module.exports.confirmPayment = async function (event) {
    const mysql = event.mysql;

    const paymentId = event.pathParameters.paymentId;
    if(!paymentId){
        return {
            code: 400,
            body: {
                code: "SH001"
            }
        };
    }
    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    if (!user.id) {
        return {
            code: 401,
            body: {
                code: "SH003"
            }
        };
    }

    //Compruebo el pago
    let payment = await stripe.paymentIntents.retrieve(paymentId);
    console.log(payment);
    if(!payment.metadata.premiumDownloads){
        return {
            code: 401,
            body: {
                code: "SH004"
            }
        };
    }
    if(payment.status === "succeeded"){
        await addPremiumDownload(mysql, user.id, payment.metadata.premiumDownloads);

        await stripe.paymentIntents.update(paymentId, {metadata: {premiumDownloads:null}}); //Evitar pagos multiples, elimino premiumDownloads, para ello hay que ponerlo a null
        return {
            code: 200,
            body: {
                status: payment.status, //succeeded,requires_action,requires_source
                premiumDownloads: payment.metadata.premiumDownloads
            }
        };
    }else{
        return {
            code: 401,
            body: {
                code: "SH004"
            }
        };
    }
 
 }

async function addPremiumDownload(mysql, userId, premiumDownloads){
    let sql = "UPDATE user SET premiumDownloads = premiumDownloads + ? WHERE userId = ?";
    await mysql.query(sql, [premiumDownloads, userId]);
}