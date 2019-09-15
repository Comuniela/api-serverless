const Mailgun = require('mailgun-js');
const Handlebars = require("handlebars");
const fetch = require("node-fetch");

const FOOTER_TPL = "http://s3-eu-west-1.amazonaws.com/wuolah-public/mail/templates/es/footer_template.html";

/**
 * Send email
 * @param {*} event 
 */
module.exports.sendMail = async function (snsData) {
    const prodMode = snsData.TopicArn.split(":").pop() == 'api-mailing_prod';
    const mailgun = new Mailgun({
        apiKey: process.env.MAILGUN_APIKEY,
        domain: prodMode ? process.env.MAILGUN_PROD_DOMAIN : process.env.MAILGUN_DEV_DOMAIN
    });

    const data = JSON.parse(snsData.Message || null);
    if (!data) return {
        code: 400,
        body: {
            message: "Missing required parameters"
        }
    };
    if (!data.recipients) return {
        code: 400,
        body: {
            message: "Invalid recipients list"
        }
    };

    // retrieve mail template
    let tplResponse = await fetch(data.template);
    let template = await tplResponse.text();

    // generate context
    const context = data.templateData || {};

    // compile mail template
    const templateHtml = Handlebars.compile(template);

    // retrieve footer template
    let footerResponse = await fetch(data.footerTemplate || FOOTER_TPL);
    context.footer = await footerResponse.text();

    // retrieve copyright template
    if (data.copyrightTemplate) {
        let copyrightResponse = await fetch(data.copyrightTemplate);
        context.copyright = await copyrightResponse.text();
    }

    let html = templateHtml(context);

    // set mailgun properties
    const mailData = {
        from: data.sender || "Wuolah <noreply@wuolah.com>",
        to: data.recipients,
        bcc: data.bcc || "correowuolah@gmail.com",
        subject: data.subject,
        html,
        'o:tracking': true,
        'o:tracking-clicks': true,
        'o:tracking-opens': true,
        'o:testmode': data.testMode || false
    };
    if (data.tag != null) mailData['o:tag'] = data.tag;

    // send mail to recipients
    const response = await mailgun.messages().send(mailData);
    return {
        code: 200,
        body: response
    };
}