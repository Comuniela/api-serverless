const db = require("../../common/db");
const service = require("./service");

exports.handler = async (event) => {
    try {
        // configure mysql
        const config = {
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME
        };
        await db.configure(config);
        event.mysql = db;

        let result;
        switch (event.httpMethod) {
            case "POST":
                {
                    if (event.resource == "/login") {
                        result = await service.login(event);
                    } else if (event.resource == "/signup") {
                        result = await service.signup(event);
                    } else if (event.resource == "/login/refresh") {
                        result = await service.refresh(event);
                    } else if (event.resource == "/auth/facebook") {
                        result = await service.fbAuthAccessToken(event);
                    } else {
                        result = {
                            code: 400,
                            body: {
                                message: `Resource ${event.resource} not found`
                            }
                        };
                    }
                    break;
                }
            default:
                result = {
                    code: 405,
                    body: {
                        message: "Http method not allowed"
                    }
                };
        }

        const response = {
            statusCode: result.code,
            headers: {
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify(result.body)
        };
        return response;
    } catch (err) {
        console.log(err);
        const response = {
            statusCode: 500,
            headers: {
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({
                message: err.message,
                code: "LO000"
            })
        };
        return response;
    }
};