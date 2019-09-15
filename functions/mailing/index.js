const service = require("./service");

exports.handler = async (event) => {
    try {
        if (event.Records.length) {
            const data = event.Records[0].Sns;
            await service.sendMail(data);
            callback(null, "Email sent successfully");
        } else {
            callback("Invalid input");
        }
    } catch (err) {
        callback(err);
    }
};