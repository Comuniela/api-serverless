const jwt = require("jsonwebtoken");
const qs = require('qs');
const AWS = require('aws-sdk');
const sns = new AWS.SNS();
const moment = require("moment");
const documentClient = new AWS.DynamoDB.DocumentClient({
    "region": "eu-west-1"
});
const uuid = require('uuid/v4');
const jsSHA = require('jssha');
const request = require('request-promise');
const bcrypt = require('bcryptjs');

/**
 * Login user
 * @param {*} event 
 */
module.exports.login = async function (event) {
    const mysql = event.mysql;
    let connection;

    try {
        let data;
        if (event.headers['Content-Type'] == 'application/x-www-form-urlencoded') {
            data = qs.parse(event.body || null);
        } else {
            data = JSON.parse(event.body || null);
        }
        if (!data) return {
            code: 400,
            body: {
                code: "LO001"
            }
        };
        const email = data.email;
        const password = data.password;
        const ip = event.requestContext.identity.sourceIp;

        if (email === '' || !validateEmail(email)) return {
            code: 400,
            body: {
                code: "LO002"
            }
        };
        else if (password === '') return {
            code: 400,
            body: {
                code: "LO003"
            }
        };

        let sql = `SELECT user.*, user_banned.bglobal FROM user 
            LEFT JOIN user_banned ON user_banned.userId = user.userId 
            WHERE user.mail = ? AND user.deleted = 0;`;
        let rows = await mysql.query(sql, [email]);

        if (!rows.length) return {
            code: 404,
            body: {
                code: "LO004"
            }
        }
        else if (rows.length > 1) return {
            code: 500,
            body: {
                code: "LO005"
            }
        }

        let user = rows[0];

        if (user.bglobal) {
            return {
                code: 403,
                body: {
                    code: 'LO006'
                }
            };
        }

        //Temporal, actualizar las contraseña de los usuarios
        connection = await mysql.beginTransaction();
        if (user.pass.length >= 100 && user.pass == password) {
            let newPassword = bcrypt.hashSync(password, Number(10));
            await connection.query("UPDATE user SET pass = ? WHERE userId = ?", [newPassword, user.userId]);
            user.pass = newPassword;
        }

        // check password
        let correctPassword = await bcrypt.compare(password, user.pass);
        if (correctPassword) {

            // generate token
            let token = jwt.sign({
                id: user.userId,
                role: user.role,
                email: user.mail
            }, process.env.JWT_SECRET, {
                expiresIn: parseInt(process.env.SESSIONTOKEN_EXPIRATION)
            });

            let expires_token = moment.utc().add(process.env.SESSIONTOKEN_EXPIRATION, 'seconds').format();

            // generate refresh token
            let refresh_token = jwt.sign({
                id: user.userId
            }, process.env.JWT_SECRET_REFRESH, {
                expiresIn: parseInt(process.env.REFRESHTOKEN_EXPIRATION)
            });
            
            let expires_refreshToken = moment.utc().add(process.env.REFRESHTOKEN_EXPIRATION, 'seconds').format();

            // begin transaction
            connection = await mysql.beginTransaction();

            // register session
            await connection.query("UPDATE user SET lastConnection = NOW() WHERE userId = ?", [user.userId]);
            await connection.query("INSERT INTO sessions SET userId = ?, ip = ?", [user.userId, ip]);
            await connection.query("INSERT INTO refresh_token SET userId = ?, refreshToken = ?, expired = ?", [user.userId, refresh_token, expires_refreshToken]);

            // commit all changes and end connection
            await connection.commit();

            return {
                code: 200,
                body: {
                    accessToken: token,
                    expires: expires_token,
                    refreshToken: refresh_token
                }
            };

        } else {
            //Temporal
            connection.rollback();

            return {
                code: 401,
                body: {
                    code: "LO007"
                }
            }
        }
    } catch (err) {
        if (connection) await connection.rollback();
        throw err;
    }
}

/**
 * Refresh token
 * @param {*} event 
 */
module.exports.refresh = async function (event) {
    const mysql = event.mysql;
    let connection;

    try {
        let body;
        if (event.headers['Content-Type'] == 'application/x-www-form-urlencoded') {
            body = qs.parse(event.body || null);
        } else {
            body = JSON.parse(event.body || null);
        }
        if (!body.refreshToken || !body.token) return {
            code: 401,
            body: {
                code: "LO009"
            }
        }
        body.token = body.token.replace(/^JWT\s/, '');
        body.refreshToken = body.refreshToken.replace(/^JWT\s/, '');

        let tokenDecoded;
        try {
            tokenDecoded = jwt.verify(body.token, process.env.JWT_SECRET, {
                ignoreExpiration: true
            });
            let user_refreshToken = jwt.verify(body.refreshToken, process.env.JWT_SECRET_REFRESH, {
                clockTolerance: 60
            });
            if (tokenDecoded.id != user_refreshToken.id) throw new Error('Invalid token');
        } catch (e) {
            return {
                code: 401,
                body: {
                    code: "LO021"
                }
            }
        }

        // begin transaction
        connection = await mysql.beginTransaction();

        let rows = await connection.query("SELECT user.userId, user.role, user.mail FROM refresh_token \
            INNER JOIN user ON user.userId = refresh_token.userId AND user.deleted = 0 WHERE refresh_token.userId = ? AND refresh_token.refreshToken = ? FOR UPDATE;",
            [tokenDecoded.id, body.refreshToken]);
        if (!rows.length) {
            connection.rollback();
            return {
                code: 401,
                body: {
                    code: "LO020"
                }
            }
        }

        let user = rows[0];

        // generate token
        token = jwt.sign({
            id: user.userId,
            role: user.role,
            email: user.mail
        }, process.env.JWT_SECRET, {
            expiresIn: parseInt(process.env.SESSIONTOKEN_EXPIRATION)
        });
        
        let expires_token = moment.utc().add(process.env.SESSIONTOKEN_EXPIRATION, 'seconds').format();

        // generate refresh token
        let refresh_token = jwt.sign({
            id: user.userId
        }, process.env.JWT_SECRET_REFRESH, {
            expiresIn: parseInt(process.env.REFRESHTOKEN_EXPIRATION)
        });

        let expires_refreshToken = moment.utc().add(process.env.REFRESHTOKEN_EXPIRATION, 'seconds').format();

        await connection.query("DELETE FROM refresh_token WHERE userId = ? AND refreshToken  = ?", [user.userId, body.refreshToken]);
        await connection.query("INSERT INTO refresh_token SET userId = ?, refreshToken = ?, expired = ?", [user.userId, refresh_token, expires_refreshToken]);

        // commit all changes and end connection
        await connection.commit();

        return {
            "code": 200,
            "body": {
                accessToken: token,
                expires: expires_token,
                refreshToken: refresh_token
            }
        }
    } catch (err) {
        if (connection) await connection.rollback();
        throw err;
    }
}

/**
 * Signup user
 * @param {*} connection 
 * @param {*} event 
 */
module.exports.signup = async function (event) {
    const mysql = event.mysql;
    let connection;
    try {
        let data;
        if (event.headers['Content-Type'] == 'application/x-www-form-urlencoded') {
            data = qs.parse(event.body || null);
        } else {
            data = JSON.parse(event.body || null);
        }
        if (!data) return {
            code: 400,
            body: {
                code: "LO001"
            }
        };
        const email = data.email;
        const repeatEmail = data.repeatEmail;
        const password = data.password;
        const language = data.language || "es_ES";
        const gdpr_mailing = data.gdpr_mailing || 0;
        const invitationCode = data.invitationCode || null;
        const ip = event.requestContext.identity.sourceIp || '0.0.0.0';

        if (email === '' || !validateEmail(email)) return {
            code: 400,
            body: {
                code: "LO010"
            }
        };
        else if (email != repeatEmail) return {
            code: 400,
            body: {
                code: "LO011"
            }
        };
        else if (password === '' || password.length != 128) return {
            code: 400,
            body: {
                code: "LO012"
            }
        };

        // check disposable mail
        let mailDomain = email.replace(/.*@/, "");
        let veredict = await request({
            uri: `https://open.kickbox.com/v1/disposable/${mailDomain}`,
            json: true
        });
        if (veredict.disposable) return {
            code: 422,
            body: {
                code: "LO013"
            }
        };

        let rows = [];
        if (mailDomain == 'gmail.com') {
            let emails = [email, `${email.replace(/\./g, "")}`];
            rows = await mysql.query("SELECT userId FROM user WHERE REPLACE(mail, \".\", \"\") IN (?)", [emails]);
        } else {
            rows = await mysql.query("SELECT userId FROM user WHERE mail = ?", email);
        }

        if (rows.length) return {
            code: 409,
            body: {
                code: "LO014"
            }
        };

        rows = await mysql.query("SELECT id FROM language WHERE code = ?", language);
        if (!rows.length) {
            return {
                code: 406,
                body: {
                    code: "LO015"
                }
            }
        }

        // check invitation code and store inviter
        let inviter;
        if (invitationCode !== null) {
            rows = await mysql.query("SELECT user.userId, user.mail FROM user WHERE invitationCode = ?", invitationCode);
            if (!rows.length) return {
                code: 404,
                body: {
                    code: "LO016"
                }
            };
            inviter = rows[0];
        }

        const confirmationCode = Math.floor(Math.random() * 900000) + 100000;
        const passResetCode = Math.floor(Math.random() * 900000) + 100000;

        // begin transaction
        connection = await mysql.beginTransaction();

        // insert user
        const result = await connection.query(`INSERT INTO user SET mail = ?, pass = ?, confirmationCode = ?, 
            signUpIp = ?, passRestart = ?, passUpdated = 1, lastConnection = NOW(), conditions = 1, gdpr_mailing = ?, gdpr_advice = 1, language = ?`,
            [email, bcrypt.hashSync(password, Number(10)), confirmationCode, ip, passResetCode, gdpr_mailing, language]);
        rows = await connection.query("SELECT * FROM user WHERE userId = ?", result.insertId);
        if (!rows.length) {
            await connection.rollback();
            return {
                code: 500,
                body: {
                    code: "LO017",
                }
            };
        }

        let user = rows[0];

        // register session
        await connection.query("INSERT INTO sessions SET userId = ?, ip = ?", [user.userId, ip]);

        // send confirmation email
        await sendConfirmationEmail(user.mail, event, connection);

        // store invitation data and increase premium downloads
        if (inviter) {
            await storeInvitation(inviter, user, connection, event);
        }

        // generate token
        let token = jwt.sign({
            id: user.userId,
            role: user.role,
            email: user.mail
        }, process.env.JWT_SECRET, {
            expiresIn: parseInt(process.env.SESSIONTOKEN_EXPIRATION)
        });

        let expires_token = moment.utc().add(process.env.SESSIONTOKEN_EXPIRATION, 'seconds').format();

        // generate refresh token
        let refresh_token = jwt.sign({
            id: user.userId
        }, process.env.JWT_SECRET_REFRESH, {
            expiresIn: parseInt(process.env.REFRESHTOKEN_EXPIRATION)
        });

        let expires_refreshToken = moment.utc().add(process.env.REFRESHTOKEN_EXPIRATION, 'seconds').format();

        await connection.query("INSERT INTO refresh_token SET userId = ?, refreshToken = ?, expired = ?", [user.userId, refresh_token, expires_refreshToken]);

        // commit all changes and end connection
        await connection.commit();

        return {
            code: 200,
            body: {
                accessToken: token,
                expires: expires_token,
                refreshToken: refresh_token
            }
        };
    } catch (err) {
        if (connection) await connection.rollback();
        throw err;
    }
}

var storeInvitation = async function (inviter, invitee, connection, event) {
    //We need the centerId of the inviter to get the rewards
    let inviter_info = await connection.query("select centerId, partnerType from student_study inner join user on student_study.userId = user.userId and student_study.default=1 where student_study.userId=?", [inviter.userId]);
    inviter_info = inviter_info[0]
    inviter_info.partnerType = inviter_info.partnerType ? inviter_info.partnerType : 0

    //We get the rewards on the dynamodb table
    let prefix = process.env.DYNAMODB_PREFIX ? process.env.DYNAMODB_PREFIX : "prod_"
    var params = {
        TableName: `${prefix}invitationRewards`,
        KeyConditionExpression: 'centerId = :c and created <= :d',
        ExpressionAttributeValues: {
            ':c': inviter_info.centerId,
            ':d': new Date().getTime()
        },
        ScanIndexForward: false,
        Limit: 1
    };

    let dynamo_response = await documentClient.query(params).promise()
    let inviter_rewards = dynamo_response.Items[0]["inviter"]["partnerType_" + inviter_info.partnerType]
    let invited_rewards = dynamo_response.Items[0]["invited"]["partnerType_" + inviter_info.partnerType]

    await connection.query(`INSERT INTO invitation 
        (inviterId, inviteeId, popularity, money, premiumDownloads, tickets, inviteePopularity, inviteeMoney, 
        inviteePremiumDownloads, inviteeTickets, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [inviter.userId, invitee.userId, inviter_rewards.popularity, inviter_rewards.money,
        inviter_rewards.premiumDownloads, inviter_rewards.tickets, invited_rewards.popularity, invited_rewards.money,
        invited_rewards.premiumDownloads, invited_rewards.tickets, moment.utc().format()
        ]);
}

async function sendConfirmationEmail(email, event, connection) {
    let rows = await connection.query("SELECT userId, mail, confirmationCode FROM user WHERE mail = ?;", email);

    if (!rows.length) {
        return {
            code: 404,
            body: {
                message: "User not found",
            }
        };
    } else if (rows.length > 1) {
        let email = rows[0].mail;
        return {
            code: 409,
            body: {
                message: "Duplicate user",
            }
        };
    }

    let user = rows[0];

    if (user.confirmationCode == undefined || user.confirmationCode == null) {
        throw {
            code: 500,
            body: {
                code: "LO018",
            }
        };
    } else if (user.confirmationCode == 0) {
        throw {
            status: 400,
            body: {
                code: "LO018",
            }
        };
    }

    let data = {
        "recipients": [user.mail],
        "bcc": "correowuolah@gmail.com",
        "subject": "Confirma tu cuenta de Wuolah",
        "template": "https://s3-eu-west-1.amazonaws.com/wuolah-public/mail/templates/es/account/confirm_account.html",
        "footerTemplate": "http://s3-eu-west-1.amazonaws.com/wuolah-public/mail/templates/es/footer_template.html",
        "templateData": {
            "userId": user.userId,
            "confirmationCode": user.confirmationCode
        },
        "tag": "account",
        "testMode": process.env.LAMBDAVERSION == 'dev' &&
            !user.mail.includes("@wuolah.com")
    }

    return await sendEmail(data, event);
}

async function sendEmail(data, event) {
    const params = {
        Message: JSON.stringify(data),
        TopicArn: process.env.TOPIC_MAILING
    };

    const response = await sns.publish(params).promise();
    return response;
}

module.exports.fbAuthAccessToken = async function (event) {
    const mysql = event.mysql;

    // get body properties
    let data;
    if (event.headers['Content-Type'] == 'application/x-www-form-urlencoded') {
        data = qs.parse(event.body || null);
    } else {
        data = JSON.parse(event.body || null);
    }
    if (!data) return {
        code: 400,
        body: {
            code: "LO001"
        }
    };
    const accessToken = data.accessToken;
    const invitationCode = data.invitationCode || null;
    const ip = event.requestContext.identity.sourceIp || '0.0.0.0';

    let user;
    let connection;
    try {

        // Validate the social token with Facebook
        let profile = await request({
            uri: `https://graph.facebook.com/me?fields=id,name,birthday,picture,email`,
            qs: {
                access_token: accessToken
            },
            json: true
        });

        let facebookId = profile.id;
        if (!profile.email) profile.email = `${facebookId}@facebook.com`;

        let rows = await mysql.query(`SELECT * FROM user WHERE facebookId = ?;`, [facebookId]);

        // begin transaction
        connection = await mysql.beginTransaction();

        if (!rows.length) {
            let rows = await connection.query(`SELECT user.userId, role, mail, facebookId, confirmationCode = 0 AS 'confirmed', signUpDate, 
                premiumDownloads, pro, bsocial, bglobal, conditions, popup FROM user 
                LEFT JOIN user_banned ON user_banned.userId = user.userId WHERE user.mail = ?;`, [profile.email]);

            if (!rows.length) {
                // register new user
                user = await registerFacebookUser(event, connection, profile, ip, false, invitationCode);
            } else {
                // connect facebook account
                user = await connectFacebookUser(connection, rows[0], profile, false);
            }
        } else {
            // login successfull
            user = rows[0];
            user.newUser = false;
        }

        if (!user) {
            connection.rollback();
            return {
                code: 500,
                body: {
                    code: "LO019"
                }
            };
        }

        // register session
        await connection.query("UPDATE user SET lastConnection = NOW() WHERE userId = ?", [user.userId]);
        await connection.query("INSERT INTO sessions (userId, dateTime, ip) VALUES (?, NOW(), ?)", [user.userId, ip]);

        //generate token
        let token = jwt.sign({
            id: user.userId,
            role: user.role,
            email: user.mail
        }, process.env.JWT_SECRET, {
            expiresIn: parseInt(process.env.SESSIONTOKEN_EXPIRATION)
        });

        // generate refresh token
        let refresh_token = jwt.sign({
            id: user.userId
        }, process.env.JWT_SECRET_REFRESH, {
            expiresIn: parseInt(process.env.REFRESHTOKEN_EXPIRATION)
        });
        
        let expires_refreshToken = moment.utc().add(process.env.REFRESHTOKEN_EXPIRATION, 'seconds').format();

        await connection.query("INSERT INTO refresh_token SET userId = ?, refreshToken = ?, expired = ?", [user.userId, refresh_token, expires_refreshToken]);

        // commit all changes and end connection
        await connection.commit();

        return {
            code: 200,
            body: {
                accessToken: token,
                expires: expired_token,
                refreshToken: refresh_token
            }
        };
    } catch (err) {
        if (connection) connection.rollback();
        throw err;
    }
};

var registerFacebookUser = async function (event, connection, profile, signUpIp, viaPassport, inviterCode) {
    try {
        let email = viaPassport ? profile.emails[0].value : profile.email;
        let facebookId = viaPassport ? profile._json.id : profile.id;

        let rows = await connection.query(`SELECT user.userId, role, mail, facebookId, confirmationCode = 0 AS 'confirmed', 
            signUpDate, premiumDownloads, pro, bsocial, bglobal, conditions, popup, language, countryId  
            FROM user LEFT JOIN user_banned ON user_banned.userId = user.userId 
            WHERE user.mail = ?;`, [email]);
        if (rows.length) {
            return {
                code: 409,
                body: {
                    message: 'User already exists',
                }
            };
        }

        // check invitation code and store inviter

        let inviter;
        if (inviterCode != null) {
            rows = await connection.query("SELECT user.userId, user.mail FROM user WHERE invitationCode = ? ", [inviterCode]);
            if (rows.length) {
                inviter = rows[0];
            } else {
                return {
                    code: 409,
                    body: {
                        message: 'Invalid invitation code',
                    }
                };
            }
        }

        // generate codes
        let confirmationCode = 0;
        let passResetCode = Math.floor(Math.random() * 900000) + 100000;

        // hash password
        let password = uuid();
        let shaObj = new jsSHA("SHA-512", "TEXT");
        shaObj.update(password);
        let hash = shaObj.getHash("HEX");

        // create user
        let result = await connection.query(`INSERT INTO user (mail, pass, facebookId, confirmationCode, signUpIp, signUpDate, passRestart, passUpdated, conditions) 
        VALUES (?, ?, ?, ?, ?, NOW(), ?, 1, 1)`, [email, bcrypt.hashSync(hash, Number(10)), facebookId, confirmationCode, signUpIp, passResetCode]);

        // check if user has been created successfully
        rows = await connection.query(`SELECT user.userId, role, mail, facebookId, confirmationCode = 0 AS 'confirmed', signUpDate, 
            premiumDownloads, pro, bsocial, bglobal, conditions, popup, language, countryId 
            FROM user 
            LEFT JOIN user_banned ON user_banned.userId = user.userId 
            WHERE user.userId = ?;`, [result.insertId]);

        if (!rows.length) {
            return {
                code: 500,
                body: {
                    message: 'New record has not been persisted',
                }
            };
        }

        let user = rows[0];
        user.newUser = true;

        // store invitation data
        if (inviter != null) {
            await storeInvitation(inviter, user, connection, event);
        }

        return user;
    } catch (err) {
        if (connection) connection.rollback();
        throw err;
    }
}

var connectFacebookUser = async function (connection, user, profile, viaPassport) {
    try {
        let facebookId = viaPassport ? profile._json.id : profile.id;
        let email = viaPassport ? profile.emails[0].value : profile.email;

        await connection.query("UPDATE user SET facebookId = NULL WHERE facebookId = ? AND mail = ?;", [facebookId, email]);
        await connection.query(`UPDATE user SET facebookId = ? WHERE userId = ?;`, [facebookId, user.userId]);

        // check if user has been updated successfully
        let rows = await connection.query(`SELECT user.userId, role, mail, facebookId, confirmationCode = 0 AS 'confirmed', signUpDate, 
            premiumDownloads, pro, bsocial, bglobal, conditions, popup, language, countryId 
            FROM user LEFT JOIN user_banned ON user_banned.userId = user.userId 
            WHERE user.userId = ?;`, [user.userId]);
        if (!rows.length) {
            return {
                code: 500,
                body: {
                    message: 'New record has not been persisted'
                }
            }
        }

        let connectedUser = rows[0];
        connectedUser.newUser = false;
        return connectedUser;
    } catch (err) {
        if (connection) connection.rollback();
        throw err;
    }
}

function validateEmail(email) {
    var re = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    return re.test(String(email).toLowerCase());
}