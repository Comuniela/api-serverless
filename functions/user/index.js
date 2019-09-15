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
                {
                    if (event.resource == "/user") {
                        result = await service.searchUsers(event);
                    } else if (event.resource == "/user/me") {
                        result = await service.getAuthenticatedUser(event);
                    } else if (event.resource == "/user/tutorial") {
                        result = await service.getUserTutorials(event);
                    } else if (event.resource == "/user/invitation") {
                        result = await service.getUserInvitations(event);
                    } else if (event.resource == "/user/invitation_reward") {
                        result = await service.getInvitationReward(event);
                    } else if (event.resource == "/user/invitation_reward/invitations") {
                        result = await service.getInvitedInvitationRewards(event);
                    } else if (event.resource == "/user/confirm-account") {
                        result = await service.sendConfirmationEmail(event);
                    } else if (event.resource == "/user/reset-password") {
                        result = await service.sendResetPasswordEmail(event);
                    } else if (event.resource == "/user/stats") {
                        result = await service.getStats(event);
                    } else if (event.resource == "/user/{userId}") {
                        result = await service.getUser(event);
                    } else if (event.resource == "/user/{userId}/docs") {
                        result = await service.getUserDocuments(event);
                    } else {
                        result = {
                            code: 404,
                            body: {
                                message: `Resource ${event.resource} not found`
                            }
                        };
                    }
                    break;
                }
            case "POST":
                {
                    if (event.resource == "/user/tutorial") {
                        result = await service.markTutorialAsSeen(event);
                    } else if (event.resource == "/user/reset-password") {
                        result = await service.resetPassword(event);
                    } else if (event.resource == "/user/confirm-account") {
                        result = await service.postConfirmAccount(event);
                    } else if (event.resource == "/user/campaign") {
                        result = await service.registerUserCampaign(event);
                    } else if (event.resource == "/user/student") {
                        result = await service.createStudentProfile(event);
                    } else if (event.resource == "/user/block") {
                        result = await service.blockUser(event);
                    } else if (event.resource == "/user/student/study") {
                        result = await service.createStudentStudy(event);
                    } else {
                        result = {
                            code: 404,
                            body: {
                                message: `Resource ${event.resource} not found`
                            }
                        };
                    }
                    break;
                }
            case "PUT":
                {
                    if (event.resource == "/user") {
                        result = await service.updateAccount(event);
                    } else if (event.resource == "/user/student") {
                        result = await service.updateStudentProfile(event);
                    } else if (event.resource == "/user/student/study/{studyId}") {
                        result = await service.updateStudentStudy(event);
                    } else if (event.resource == "/user/code") {
                        result = await service.updateInvitationCode(event);
                    } else {
                        result = {
                            code: 404,
                            body: {
                                message: `Resource ${event.resource} not found`
                            }
                        };
                    }
                    break;
                }
            case "DELETE":
                {
                    if (event.resource == "/user") {
                        result = await service.deleteAccount(event);
                    } else if (event.resource == "/user/student/study/{studyId}") {
                        result = await service.deleteStudentStudy(event);
                    } else {
                        result = {
                            code: 404,
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
        const response = {
            statusCode: 500,
            headers: {
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({
                message: err.message,
                code: 'US000'
            })
        };
        return response;
    }
};