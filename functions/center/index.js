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
            case "GET":
                if (event.resource == "/center") {
                    result = await service.searchCenters(event);
                } else if (event.resource == "/center/{centerId}") {
                    result = await service.getCenterById(event);
                } else if (event.resource == "/center/{centerId}/rewards") {
                    result = await service.getCenterByIdRewards(event);
                } else {
                    result = {
                        code: 400,
                        body: {
                            message: `Resource ${event.resource} not found`
                        }
                    };
                }
                break;
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
        const response = {
            statusCode: 500,
            headers: {
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({
                message: err.message,
                code: "CE000"
            })
        };
        return response;
    }
};