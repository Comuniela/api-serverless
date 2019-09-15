const db = require("../../common/db");
const service = require("./service");
const jwt = require("jsonwebtoken")

exports.handler = async (event) => {
    try {
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
                if (event.resource == "/giveaway") {
                    result = await service.searchGiveaways(event);
                } else if (event.resource == "/giveaway/ticket") {
                    result = await service.getMyTickets(event);
                } else if (event.resource == "/giveaway/{giveawayId}") {
                    result = await service.getGiveawayById(event);
                } else if (event.resource == "/giveaway/{giveawayId}/ticket") {
                    result = await service.getGiveawayTickets(event);
                } else {
                    result = {
                        code: 400,
                        body: {
                            message: `Resource ${event.resource} not found`
                        }
                    };
                }
                break;
            case "POST":
                if (event.resource == "/giveaway/{giveawayId}/ticket/redeem") {
                    result = await service.redeemTickets(event);
                } else if (event.resource == "/giveaway/{giveawayId}/ticket/{ticketId}/redeem") {
                    result = await service.redeemTicket(event);
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
        console.log(err);
        const response = {
            statusCode: 500,
            headers: {
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({
                message: err.message,
                code: "GI000"
            })
        };
        return response;
    }
};