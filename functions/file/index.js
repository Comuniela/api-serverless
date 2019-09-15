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
                if (event.resource == "/file") {
                    result = await service.searchFiles(event);
                } else if (event.resource == "/file/{fileId}") {
                    result = await service.getFileById(event);
                } else if (event.resource == "/file/{fileId}/like") {
                    result = await service.getFileLikes(event);
                } else if (event.resource == "/file/{fileId}/thumbnail") {
                    result = await service.getThumbnail(event);
                } else if (event.resource == "/file/{fileId}/preview") {
                    result = await service.previewFile(event);
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
                if (event.resource == "/file/{fileId}/view") {
                    result = await service.downloadFile(event, 0);
                } else if (event.resource == "/file/{fileId}/download") {
                    result = await service.downloadFile(event, 1);
                } else if (event.resource == "/file/{fileId}/print") {
                    result = await service.printFile(event);
                } else if (event.resource == "/file/{fileId}/recover") {
                    result = await service.recoverFile(event);
                } else if (event.resource == "/file/{fileId}/share") {
                    result = await service.share(event);
                } else {
                    result = {
                        code: 400,
                        body: {
                            message: `Resource ${event.resource} not found`
                        }
                    };
                }
                break;
            case "PUT":
                if (event.resource == "/file/{fileId}/like") {
                    result = await service.like(event);
                } else {
                    result = {
                        code: 400,
                        body: {
                            message: `Resource ${event.resource} not found`
                        }
                    };
                }
                break;
            case "DELETE":
                if (event.resource == "/file/{fileId}") {
                    result = await service.deleteFile(event);
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
                code: "FI000"
            })
        };
        return response;
    }
};