const AWS = require('aws-sdk');
const qs = require('qs');
const sns = new AWS.SNS({
    "region": "eu-west-1"
});
const documentClient = new AWS.DynamoDB.DocumentClient({
    "region": "eu-west-1"
});
const s3 = new AWS.S3({
    apiVersion: '2006-03-01'
});
const s3WebUsers = new AWS.S3({
    accessKeyId: process.env.S3_WEB_USERS_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_WEB_USERS_ACCESS_KEY_SECRET
});
const moment = require('moment');
const removeDiacritics = require('diacritics').remove;
const slugify = require('slugify');
const bcrypt = require('bcryptjs');

/**
 * Search user by email, facebookId, signup date or invitation code.
 * @param {*} event 
 */
module.exports.searchUsers = async function (event) {
    const mysql = event.mysql;
    // get query string properties
    const {
        userId,
        mail,
        nickname,
        facebookId,
        link,
        gtSignupDate,
        ltSignupDate,
        gteSignupDate,
        lteSignupDate,
        invitationCode,
        centerId,
        studyId,
        course,
        limit = 10,
        offset = 0
    } = event.queryStringParameters || {};

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    let columns = [
        "user.userId", "user.invitationCode", "user.nickname", "user.link", "user.popularity"
    ];
    let table = "user";
    let joins = [
        "LEFT JOIN student_study ON student_study.userId = user.userId"
    ];
    let conditions = ["user.deleted = 0"];
    let params = [];

    if (user.id != null) {
        columns.push("IF(follow_user.userId IS NULL, FALSE, TRUE) AS following");
        joins.push("LEFT JOIN follow_user ON follow_user.userId = ? AND follow_user.followedId = user.userId");
        params.push(user.id);
    }

    if (userId != null) {
        conditions.push("user.userId = ?");
        params.push(userId);
    }
    if (mail != null) {
        conditions.push("user.mail = ?");
        params.push(mail);
    }
    if (nickname != null) {
        conditions.push("user.nickname = ?");
        params.push(nickname);
    }
    if (facebookId != null) {
        conditions.push("user.facebookId = ?");
        params.push(facebookId);
    }
    if (link != null) {
        conditions.push("user.link = ?");
        params.push(link);
    }
    if (gtSignupDate != null) {
        conditions.push("user.signUpDate > ?");
        params.push(gtSignupDate);
    }
    if (ltSignupDate != null) {
        conditions.push("user.signUpDate < ?");
        params.push(ltSignupDate);
    }
    if (gteSignupDate != null) {
        conditions.push("user.signUpDate >= ?");
        params.push(gteSignupDate);
    }
    if (lteSignupDate != null) {
        conditions.push("user.signUpDate <= ?");
        params.push(lteSignupDate);
    }
    if (invitationCode != null) {
        conditions.push("user.invitationCode = ?");
        params.push(invitationCode);
    }
    if (centerId) {
        conditions.push("student_study.centerId = ?");
        params.push(centerId);
    }
    if (studyId) {
        conditions.push("student_study.studyId = ?");
        params.push(studyId);
    }
    if (course) {
        conditions.push("student_study.course = ?");
        params.push(course);
    }

    let sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")} GROUP BY user.userId LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));

    // find users with provided mail
    const rows = await mysql.query(sql, params);
    return {
        code: 200,
        body: rows
    };
}

/**
 * Get authenticated user.
 * @param {*} event 
 */
module.exports.getAuthenticatedUser = async function (event) {
    const mysql = event.mysql;
    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    if (!user.id) {
        return {
            code: 401,
            body: {
                code: "US001"
            }
        };
    }

    // get query string properties
    const {
        coins = 0
    } = event.queryStringParameters || {};

    let promises = [];
    let columns = [
        "user.userId", "user.role", "user.mail", "user.facebookId", "IF(user.confirmationCode = 0, 1, 0) AS confirmed", "user.invitationCode",
        "user.premiumDownloads", "user.captchaCounter",
        "user.conditions", "user.gdpr_mailing", "user.gdpr_advice", "user.popup",
        "user.language", "user.countryId",
        "(SELECT COUNT(*) FROM file INNER JOIN upload ON upload.id = file.uploadId AND upload.deleted = 0 WHERE file.userId = user.userId AND file.deleted = 0) AS numDocs",
        "(SELECT COUNT(*) FROM social WHERE social.type = 'DOUBT' AND social.deleted = 0 AND social.userId = user.userId) AS numQuestions",
        "(SELECT COUNT(*) FROM follow_user WHERE follow_user.userId = user.userId) AS numFollowing",
        "(SELECT COUNT(*) FROM student_study WHERE (centerId, studyId, course) IN (SELECT centerId, studyId, course FROM student_study WHERE student_study.userId = user.userId)) AS numClassmates"
    ];
    let table = "user";
    let joins = [];
    let conditions = ["user.userId = ?"];
    let params = [user.id];

    // country props
    if (coins == 1) {
        columns.push("seg_country.value", "seg_country.currency");
        joins.push("INNER JOIN seg_country ON seg_country.id = user.countryId");
    }

    let sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;
    promises.push(mysql.query(sql, params));

    // student profile
    columns = [
        "user.nickname", "user.name", "user.popularity",
        "user.paypal", "user.paypalVerified",
        "user.link", "user.gender", "user.partnerType",
        "user.birthday", "user.born", "TIMESTAMPDIFF(YEAR, user.birthday, CURDATE()) AS age",
        "user.money", "user.accumulated", "user.displayMoney",
    ];
    table = "user";
    joins = [];
    conditions = ["user.userId = ?", "user.nickname IS NOT NULL"];
    params = [user.id];
    sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;
    promises.push(mysql.query(sql, params));

    // bookmarked files
    columns = ["file.id", "file.uploadId", "file.centerId", "file.studyId", "file.course", "file.folderId",
        "file.name", "file.extension", "file.fileType", "file.pages",
        "file.previews", "file.views", "file.downloads", "file.likes", "file.dislikes",
        `IF(!file.anonymous OR file.userId = ${user.id}, file.userId, NULL) AS userId`,
        `IF(file.userId = ${user.id}, file.money, NULL) AS money`,
        "NULL AS hiddenDirectory", "NULL AS hiddenFile",
        "file.uploadDate"
    ];
    table = "follow_file";
    joins = [
        "INNER JOIN file ON file.id = follow_file.followedId"
    ];
    conditions = ["follow_file.userId = ?"];
    params = [user.id];
    sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;
    promises.push(mysql.query(sql, params));

    // user lists
    promises.push(mysql.query("SELECT * FROM `list` WHERE userId = ?", user.id));

    // user studies
    sql = `SELECT student_study.id, student_study.centerId, student_study.studyId,
        student_study.course, student_study.default, 
        center.name AS centerName, 
        center.nameLink as centerNameLink, center.cityId, 
        study.name AS studyName, study.visible AS studyVisible, 
        rel_center_study.courses, rel_center_study.type, 
        seg_university.id AS universityId, seg_university.name AS universityName 
        FROM student_study 
        JOIN center ON student_study.centerId=center.id 
        JOIN study ON student_study.studyId=study.id 
        JOIN rel_center_study ON rel_center_study.centerId = student_study.centerId AND rel_center_study.studyId = student_study.studyId 
        LEFT JOIN seg_university ON seg_university.id = center.universityId 
        WHERE student_study.userId = ? ORDER BY studyId, course`;
    promises.push(mysql.query(sql, user.id));

    const values = await Promise.all(promises);
    if (values.length != promises.length) {
        throw new Error("Error retrieving user information");
    }

    const users = values.shift();
    const authUser = users[0];

    const profiles = values.shift();
    authUser.hasProfile = profiles.length > 0;
    authUser.profile = profiles.length > 0 ? profiles[0] : null;
    const bookmarkedFiles = values.shift();
    authUser.bookmarkedFiles = bookmarkedFiles;
    const lists = values.shift();
    authUser.numLists = lists.length;
    authUser.lists = lists;
    const studies = values.shift();
    authUser.hasStudies = studies.length > 0;
    authUser.studies = studies;

    return {
        code: 200,
        body: authUser
    };
}

/**
 * Get user information.
 * @param {*} event 
 */
module.exports.getUser = async function (event) {
    const mysql = event.mysql;
    const {
        userId
    } = event.pathParameters || {};

    let promises = [];
    let columns = [
        "user.userId", "user.mail", "user.facebookId", "user.invitationCode",
        "user.language", "user.countryId",
        "(SELECT COUNT(*) FROM file INNER JOIN upload ON upload.id = file.uploadId AND upload.deleted = 0 WHERE file.userId = user.userId AND file.deleted = 0) AS numDocs",
        "(SELECT COUNT(*) AS total FROM social WHERE social.type = 'DOUBT' AND social.deleted = 0 AND social.userId = user.userId) AS numQuestions",
        "(SELECT COUNT(*) FROM follow_user WHERE follow_user.userId = user.userId) AS numFollowing"
    ];
    let table = "user";
    let joins = [];
    let conditions = ["user.userId = ?"];
    let params = [userId];

    let sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;
    promises.push(mysql.query(sql, params));

    // student profile
    columns = [
        "user.nickname", "user.name", "user.popularity",
        "user.paypal", "user.paypalVerified",
        "user.link", "user.gender", "user.partnerType",
        "user.birthday", "user.born", "TIMESTAMPDIFF(YEAR, user.birthday, CURDATE()) AS age",
        "((user.money + user.accumulated) * user.displayMoney) AS money",
        "user.accumulated",
    ];
    table = "user";
    joins = [];
    conditions = ["user.userId = ?", "user.nickname IS NOT NULL"];
    params = [userId];
    sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;
    promises.push(mysql.query(sql, params));

    // bookmarked files
    columns = ["file.id", "file.uploadId", "file.centerId", "file.studyId", "file.course", "file.folderId",
        "file.name", "file.extension", "file.fileType", "file.pages",
        "file.previews", "file.views", "file.downloads", "file.likes", "file.dislikes",
        `IF(!file.anonymous OR file.userId = ${userId}, file.userId, NULL) AS userId`,
        `IF(file.userId = ${userId}, file.money, NULL) AS money`,
        "NULL AS hiddenDirectory", "NULL AS hiddenFile",
        "file.uploadDate"
    ];
    table = "follow_file";
    joins = [
        "INNER JOIN file ON file.id = follow_file.followedId",
    ];
    conditions = ["follow_file.userId = ?"];
    params = [userId];
    sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;
    promises.push(mysql.query(sql, params));

    // user lists
    promises.push(mysql.query("SELECT * FROM `list` WHERE userId = ?", userId));

    // user studies
    sql = `SELECT student_study.id, student_study.centerId, student_study.studyId,
        student_study.course, student_study.default, 
        center.name AS centerName, 
        center.nameLink as centerNameLink, center.cityId, 
        study.name AS studyName, study.visible AS studyVisible, 
        rel_center_study.courses, rel_center_study.type, 
        seg_university.id AS universityId, seg_university.name AS universityName 
        FROM student_study 
        JOIN center ON student_study.centerId=center.id 
        JOIN study ON student_study.studyId=study.id 
        JOIN rel_center_study ON rel_center_study.centerId = student_study.centerId AND rel_center_study.studyId = student_study.studyId 
        LEFT JOIN seg_university ON seg_university.id = center.universityId 
        WHERE student_study.userId = ? ORDER BY studyId, course`;
    promises.push(mysql.query(sql, userId));

    // execute all promises
    const values = await Promise.all(promises);
    if (values.length != 5) {
        throw new Error("Error retrieving user information");
    }

    const users = values.shift();
    const user = users[0];

    const profiles = values.shift();
    user.hasProfile = profiles.length > 0;
    user.profile = profiles.length > 0 ? profiles[0] : null;
    const bookmarkedFiles = values.shift();
    user.bookmarkedFiles = bookmarkedFiles;
    const lists = values.shift();
    user.numLists = lists.length;
    user.lists = lists;
    const studies = values.shift();
    user.hasStudies = studies.length > 0;
    user.studies = studies;

    return {
        code: 200,
        body: user
    };
}

/**
 * Get user documents.
 * @param {*} event 
 */
module.exports.getUserDocuments = async function (event) {
    const mysql = event.mysql;
    const {
        userId
    } = event.pathParameters || {};
    const {
        version = 1
    } = event.queryStringParameters || {};
    const downloaded = event.queryStringParameters ? JSON.parse(event.queryStringParameters.downloaded || null) : null;

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    let columns = ["upload.folderId", "upload.centerId", "upload.studyId", "upload.course",
        "center.name AS centerName", "study.name AS studyName", "seg_university.name AS universityName",
        "folder.name AS folderName", "rel_study_folder.id AS relationId", "rel_study_folder.verified AS folderVerified",
        "COUNT(DISTINCT file.id) AS numFiles",
    ];
    let table = "upload";
    let joins = [
        "INNER JOIN center ON center.id = upload.centerId",
        "INNER JOIN study ON study.id = upload.studyId",
        "INNER JOIN folder ON folder.id = upload.folderId",
        "INNER JOIN rel_study_folder ON rel_study_folder.centerId = upload.centerId AND rel_study_folder.studyId = upload.studyId AND rel_study_folder.course = upload.course AND rel_study_folder.folderId = upload.folderId",
        "INNER JOIN file ON file.uploadId = upload.id AND file.deleted = 0",
        "LEFT JOIN seg_university ON seg_university.id = center.universityId",
    ];
    let conditions = ["upload.deleted = 0"];
    let params = [];

    if (user.id != null) {
        columns.push("follow_folder.id IS NOT NULL AS fav");
        joins.push("LEFT JOIN follow_folder ON follow_folder.followedId = rel_study_folder.id AND follow_folder.userId = ?");
        params.push(user.id);

        if (user.id == userId) {
            if (downloaded) {
                joins.push("INNER JOIN downloads ON downloads.uploadId = upload.id");
                conditions.push("downloads.userId = ?");
                params.push(userId);
            } else {
                conditions.push("upload.userId = ?");
                params.push(user.id);
            }
        } else {
            conditions.push("upload.anonymous = 0", "upload.userId = ?");
            params.push(userId);
        }
    } else {
        conditions.push("upload.anonymous = 0", "upload.userId = ?");
        params.push(userId);
    }


    let sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")} GROUP BY upload.folderId, upload.centerId, upload.studyId`;
    const rows = await mysql.query(sql, params);
    const studies = getFoldersByUploads(version, rows);

    return {
        code: 200,
        body: studies
    };
}

/**
 * Update account information
 * @param {*} event 
 */
module.exports.updateAccount = async function (event) {
    const mysql = event.mysql;

    // get body properties
    const {
        newMail,
        password,
        newPassword,
        phone,
        conditions,
        gdpr_mailing,
        gdpr_advice,
        popup,
        language,
        countryId
    } = JSON.parse(event.body || {});

    //get userId
    let userId = event.requestContext.authorizer.id;
    let rows = await mysql.query("SELECT * FROM user WHERE userId = ? ", [userId]);
    if (!rows.length) {
        return {
            code: 404,
            body: {
                code: "US002"
            }
        };
    };

    let mail = rows[0].mail;
    let countryUserId = rows[0].countryId;

    try {
        if (newMail != undefined && (newMail === '' || !validateEmail(newMail))) {
            return {
                code: 400,
                body: {
                    code: "US003"
                }
            };
        }

        if (password != undefined && password.length != 128) {
            return {
                code: 400,
                body: {
                    code: "US004"
                }
            };
        }

        if (newPassword != undefined && (newPassword.length != 128 || newPassword == password)) {
            return {
                code: 400,
                body: {
                    code: "US005"
                }
            };
        }

        const data = {};

        // begin transaction
        connection = await mysql.beginTransaction();

        if (newMail != undefined) {
            let correctPassword = password ? await bcrypt.compare(password, rows[0].pass) : (rows[0].facebookId != null && rows[0].mail.indexOf('@facebook.com') > -1);
            if (!correctPassword) {
                await connection.rollback();
                return {
                    code: 403,
                    body: {
                        code: "US004"
                    }
                };
            }
            rows = await mysql.query('SELECT * FROM user WHERE mail = ?;', newMail);
            if (rows.length) {
                await connection.rollback();
                return {
                    code: 409,
                    body: {
                        code: "US006"
                    }
                };
            }

            data.mail = newMail;
            data.confirmationCode = Math.floor(Math.random() * 900000) + 100000;
            await connection.query('INSERT INTO user_mail SET userId = ?, oldMail = ?;', [userId, mail]);
        }

        if (newPassword != undefined) {
            let correctPassword = await bcrypt.compare(password, rows[0].pass);
            if (!correctPassword) {
                await connection.rollback();
                return {
                    code: 403,
                    body: {
                        code: "US004"
                    }
                };
            }
            data.pass = bcrypt.hashSync(newPassword, Number(10));
        }

        if (phone != undefined) data.phone = phone;
        if (conditions != undefined) data.conditions = conditions;
        if (gdpr_mailing != undefined) data.gdpr_mailing = gdpr_mailing;
        if (gdpr_advice != undefined) data.gdpr_advice = gdpr_advice;
        if (popup != undefined) data.popup = popup;
        if (language != undefined) data.language = language;
        if (countryId != undefined) data.countryId = countryId;

        if (data.countryId) {
            rows = await mysql.query("SELECT * FROM seg_country WHERE id = ? ", [data.countryId]);
            if (!rows.length) {
                await connection.rollback();
                return {
                    code: 404,
                    body: {
                        code: "US007"
                    }
                };
            };

            if (countryUserId != data.countryId) {
                await connection.query("DELETE FROM student_study WHERE userId = ? ", [userId]);
            };
        }

        if (data.language) {
            let languages = await mysql.query('SELECT * FROM language WHERE enabled = 1');
            if (!languages.some(lang => lang.code == data.language)) {
                await connection.rollback();
                return {
                    code: 404,
                    body: {
                        code: "US008"
                    }
                };
            };
        }

        if (Object.keys(data).length) {
            await connection.query("UPDATE user SET ? WHERE userId = ?", [data, userId]);
            if (newMail != undefined) {
                await sendConfirmationEmail(userId, newMail, connection);
            }
        }

        // commit all changes and end connection
        await connection.commit();

        return {
            code: 200,
            body: {
                message: "Your account has been updated successfully."
            }
        };
    } catch (err) {
        if (connection) await connection.rollback();
        throw err;
    }
};

/**
 * Get seen tutorials by user.
 * @param {*} event 
 */
module.exports.getUserTutorials = async function (event) {
    const mysql = event.mysql;
    // get query string properties
    const {
        limit = 10, offset = 0
    } = event.queryStringParameters || {};

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    if (!user.id) {
        return {
            code: 401,
            body: {
                code: "US001"
            }
        };
    }

    let columns = ["user_tutorial.tutorialId"];
    let table = "user_tutorial";
    let joins = [];
    let conditions = ["userId = ?"];
    let params = [user.id];

    let sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")} LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));
    const rows = await mysql.query(sql, params);

    return {
        code: 200,
        body: rows.map(row => row.tutorialId)
    };
}

/**
 * sets a new password and invalidates all refresh tokens
 * @param {*} event 
 */
module.exports.resetPassword = async function (event) {
    const mysql = event.mysql;
    try {
        let data;
        if (event.headers['Content-Type'] == 'application/x-www-form-urlencoded') {
            data = qs.parse(event.body || null);
        } else {
            data = JSON.parse(event.body || null);
        }

        if (!data) throw {
            "code": 400,
            "message": "Missing required parameters"
        };

        let email = data.email;
        let code = data.code;
        let password = data.password;

        let newCode = Math.floor(Math.random() * 900000) + 100000;

        if (email === '') throw {
            "code": 400,
            "id": "err_invalid_email",
            "message": "Invalid mail"
        };
        else if (password === '' || password.length != 128) throw {
            "code": "400",
            "id": "err_invalid_password",
            "message": "Invalid password"
        };

        let rows = await mysql.query("SELECT * FROM user WHERE mail = ?", [email]);

        if (!rows.length) throw {
            "code": "404",
            "id": "err_user_not_found",
            "message": "User not found"
        }

        let user = rows[0];

        if (user.passRestart != code) throw {
            "code": "403",
            "id": "msg_invalid_code",
            "throwable": true
        }

        password = bcrypt.hashSync(password, Number(10));
        await mysql.query("UPDATE user SET pass = ?, passRestart = ?, passUpdated = 1 WHERE mail = ? AND passRestart = ?", [password, newCode, email, code]);

        //Borramos los tokens de refresco de sesion
        await mysql.query("DELETE FROM refresh_token WHERE userId = ? ", [user.userId]);

        return {
            "code": 200,
            "body": {
                "id": "msg_password_updated"
            }
        }

    } catch (e) {
        throw e
    }

}


/**
 * Mark tutorial as seen by authenticated user.
 * @param {*} event 
 */
module.exports.markTutorialAsSeen = async function (event) {
    const mysql = event.mysql;
    const body = JSON.parse(event.body || null);

    if (!body || !body.tutorialId) {
        return {
            code: 400,
            body: {
                code: "US009"
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
                code: "US001"
            }
        };
    }

    // check if tutorial has already seen
    let rows = await mysql.query("SELECT * FROM user_tutorial WHERE userId = ? AND tutorialId = ?", [user.id, body.tutorialId]);
    if (rows.length) {
        return {
            code: 409,
            body: {
                code: "US010"
            }
        };
    }

    await mysql.query("INSERT INTO user_tutorial SET userId = ?, tutorialId = ?", [user.id, body.tutorialId]);

    return {
        code: 200,
        body: {
            message: `Tutorial ${body.tutorialId} has been marked as seen`
        }
    };
}

/**
 * Delete account user
 * @param {*} event 
 */
module.exports.deleteAccount = async function (event) {
    const mysql = event.mysql;

    // get body properties
    const {
        deleteFiles = false,
        password,
        comments = 'Sin motivo'
    } = JSON.parse(event.body || {});

    //get userId
    let userId = event.requestContext.authorizer.id;
    let rows = await mysql.query("SELECT mail,pass FROM user WHERE userId = ? ", [userId]);
    let user = rows[0];

    let connection;
    try {
        if (password != undefined && password.length != 128)
            return {
                code: 400,
                body: {
                    code: "US004"
                }
            };

        let correctPassword = await bcrypt.compare(password, user.pass);
        if (!rows.length || !correctPassword)
            return {
                code: 403,
                body: {
                    code: "US004"
                }
            };

        // begin transaction
        connection = await mysql.beginTransaction();

        // delete profile
        await connection.query(`UPDATE user 
            SET mail = CONCAT("baja.", UNIX_TIMESTAMP(),".", mail),facebookId = NULL, deleted = 1, deletedComments = ?, deletedDate = NOW() 
            WHERE userId = ?;`, [comments, userId]);
        await connection.query('UPDATE user SET nickname = CONCAT(nickname, "_", UNIX_TIMESTAMP()), link = CONCAT(link, "_", UNIX_TIMESTAMP()), money = 0 WHERE userId = ?;', userId);
        await connection.query('UPDATE student_study SET removed = 1 WHERE userId = ?;', userId);

        // delete files
        if (deleteFiles) {
            await connection.query('UPDATE upload SET deleted = 1, deletedReason = 4, deletedComments = "El usuario se ha dado de baja", deletedDate = NOW(), lastUpdate = NOW() WHERE userId = ? AND deleted = 0;', userId);
            await connection.query('UPDATE file SET deleted = 1, deletedReason = 4, deletedComments = "El usuario se ha dado de baja", deletedDate = NOW(), lastUpdate = NOW() WHERE userId = ? AND deleted = 0;', userId);
        } else {
            let oldOwner = `Anterior propietario: ${userId}`;
            await connection.query('UPDATE upload SET userId = 1, anonymous = 1, deletedComments = ?, lastUpdate = NOW() WHERE userId = ?;', [oldOwner, userId]);
            await connection.query('UPDATE file SET userId = 1, anonymous = 1, deletedComments = ?, lastUpdate = NOW() WHERE userId = ?;', [oldOwner, userId]);
        }

        // delete socials
        await connection.query('UPDATE social SET deleted = 1 WHERE userId = ?;', userId);

        // archive balance requests
        await connection.query('UPDATE balance_request SET archived = 1 WHERE userId = ?;', userId);

        let data = {
            "recipients": [user.mail],
            "subject": "✅ Tu baja ha sido confirmada en Wuolah",
            "template": "https://s3-eu-west-1.amazonaws.com/wuolah-public/mail/templates/es/account/delete_account.html",
            "footerTemplate": "http://s3-eu-west-1.amazonaws.com/wuolah-public/mail/templates/es/footer_template.html",
            "tag": "account"
        };

        await sendEmail(data, event);

        // commit all changes and end connection
        await connection.commit();

        return {
            code: 200,
            body: {
                message: "Account deleted success"
            }
        };
    } catch (err) {
        if (connection) await connection.rollback();
        throw err;
    }
};


module.exports.sendConfirmationEmail = async function (event) {
    const mysql = event.mysql;

    // get query string properties
    const {
        userId,
        email
    } = event.queryStringParameters || {};

    let connection = await mysql.beginTransaction();
    let res;
    try {
        res = await sendConfirmationEmail(userId, email, connection);
    } catch (err) {
        if (connection) await connection.rollback();
        throw err;
    }

    // commit all changes and end connection
    await connection.commit();

    if (res.code == 429) {
        return res;
    }

    if (userId) {
        return {
            code: 200,
            body: {
                message: "Email send success"
            }
        };
    } else {
        let msg = JSON.parse(JSON.stringify("Se ha enviado un correo a <EMAIL>. Por favor, revisa tu bandeja de entrada"));
        msg = msg.replace(/<EMAIL>/g, email);
        return {
            code: 200,
            body: msg
        };
    }
}

module.exports.postConfirmAccount = async function (event) {
    const mysql = event.mysql;

    // get body properties
    const {
        userId,
        code
    } = JSON.parse(event.body || {});

    let connection;
    try {
        if (!userId || !code) return {
            code: 400,
            body: {
                code: "US012"
            }
        }

        let rows = await mysql.query("SELECT confirmationCode FROM user WHERE userId = ?", [userId]);
        if (!rows.length) {
            return {
                code: 404,
                body: {
                    code: "US002"
                }
            };
        }

        let user = rows[0];

        if (user.confirmationCode == 0) {
            return {
                code: 409,
                body: {
                    code: "US013"
                }
            };
        }

        if (code != user.confirmationCode) {
            return {
                code: 401,
                body: {
                    code: "US014"
                }
            };
        }

        // begin transaction
        connection = await mysql.beginTransaction();
        await connection.query("UPDATE user SET confirmationCode = 0 WHERE userId = ? AND confirmationCode = ?", [userId, code]);

        // give rewards if profile is already completed
        rows = await connection.query("SELECT * FROM user WHERE userId = ? ", [userId]);
        if (rows.length) {
            await giveInvitationRewards(userId, connection, event);
        }

        // commit all changes and end connection
        await connection.commit();

        return {
            code: 200,
            body: {
                message: "Account verified"
            }
        };
    } catch (err) {
        if (connection) connection.rollback();
        throw err;
    }
};

module.exports.registerUserCampaign = async function (event) {
    const mysql = event.mysql;

    // get body properties
    const {
        campaignId,
        method = null,
        channel = null
    } = JSON.parse(event.body || {});

    let connection;

    try {

        //get user
        let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
            id: null,
            role: null
        };

        if (!user.id) {
            return {
                code: 401,
                body: {
                    code: "US001"
                }
            };
        }
        let row = await mysql.query("SELECT * FROM user WHERE userId = ?", [user.id]);
        user = row[0];

        let rows = await mysql.query('SELECT * FROM user_campaign WHERE userId = ? AND campaignId = ?',
            [user.userId, campaignId]);
        if (!rows.length) {
            await mysql.query('INSERT INTO user_campaign SET userId = ?, campaignId = ?, method = ?, channel = ?',
                [user.userId, campaignId, method, channel]);
        }

        return {
            code: 200,
            body: {
                message: "Account update"
            }
        };
    } catch (err) {
        if (connection) connection.rollback();
        throw err;
    }
};

module.exports.createStudentProfile = async function (event) {
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
            code: "US012"
        }
    };
    const nickname = data.nickname;
    const gender = data.gender;
    let birthday = data.birthday;
    const nicknameLink = slugify(removeDiacritics(nickname)).replace(/[^A-Za-z0-9-]+/gi, '');

    let nicknameFormat = /[^_a-zA-Z0-9]/;

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    let connection;
    try {
        if (nickname.length < 5 || nickname.length > 15 ||
            nickname.indexOf("admin") != -1 || nickname.indexOf("wuolah") != -1 ||
            nicknameFormat.test(nickname)) {
            return {
                code: 400,
                body: {
                    code: "US016"
                }
            };
        } else if (gender != 1 && gender != 2) {
            return {
                code: 400,
                body: {
                    code: "US017"
                }
            };
        } else if (birthday === '') {
            return {
                code: 400,
                body: {
                    code: "US018"
                }
            };
        }

        let rows = await mysql.query("SELECT userId FROM user WHERE userId = ? AND user.nickname IS NOT NULL", [user.id]);
        if (rows.length) {
            return {
                code: 409,
                body: {
                    code: "US019"
                }
            };
        }

        rows = await mysql.query("SELECT userId FROM user WHERE nickname = ?", [nickname]);
        if (rows.length) {
            return {
                code: 409,
                body: {
                    code: "US020"
                }
            };
        }

        birthday = new Date(birthday);
        let born = birthday.getFullYear();

        // begin transaction
        connection = await mysql.beginTransaction();

        let result = await connection.query("UPDATE user SET nickname = ?, link = ?, gender = ?, birthday = ?, born = ? WHERE userId = ? ", [nickname, nicknameLink, gender, birthday, born, user.id]);

        rows = await connection.query("SELECT userId, nickname, gender, born FROM user WHERE userId = ? AND nickname IS NOT NULL", [user.id]);
        if (!rows.length) {
            await connection.rollback();
            return {
                code: 500,
                body: {
                    code: "US021",
                }
            };
        }
        let studentProfile = rows[0];

        await updateUserInvitationCode(user.id, studentProfile.nickname, connection);

        // give rewards if account is already confirmed
        rows = await connection.query("SELECT * FROM user WHERE userId = ? ", [studentProfile.userId]);
        if (rows.length && rows[0].confirmationCode == 0) {
            await giveInvitationRewards(studentProfile.userId, connection, event);
        }

        // commit all changes and end connection
        await connection.commit();

        await uploadDefaultProfilePicture(user.id, event);

        return {
            code: 200,
            body: studentProfile
        };
    } catch (err) {
        if (connection) connection.rollback();
        throw err;
    }
};

module.exports.updateStudentProfile = async function (event) {
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
            code: "US012"
        }
    };

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    let rows = await mysql.query("SELECT userId FROM user WHERE userId = ? AND nickname IS NOT NULL", [user.id]);
    if (!rows.length) {
        return {
            code: 404,
            body: {
                code: "US023",
            }
        };
    }

    let insertData = {};
    if (data.name != undefined) insertData.name = data.name;
    if (data.paypal != undefined) insertData.paypal = data.paypal;
    if (data.paypalVerified != undefined) insertData.paypalVerified = data.paypalVerified;
    if (data.gender != undefined) insertData.gender = data.gender;
    if (data.birthday != undefined) insertData.birthday = data.birthday;
    if (data.born != undefined) insertData.born = data.born;
    if (data.displayMoney != undefined) insertData.displayMoney = data.displayMoney;

    // if we change the nickname, we have to update the link
    if (data.nickname != undefined) {
        let nicknameFormat = /[^_a-zA-Z0-9]/;
        if (data.nickname.length < 5 || data.nickname.length > 15 || data.nickname.indexOf("admin") != -1 || data.nickname.indexOf("wuolah") != -1 || nicknameFormat.test(data.nickname)) {
            return {
                code: 400,
                body: {
                    code: "US016",
                }
            };
        }
        let rows = await mysql.query("SELECT userId FROM user WHERE nickname = ?", [data.nickname]);
        if (rows.length) {
            return {
                code: 409,
                body: {
                    code: "US020",
                }
            };
        }
        insertData.nickname = data.nickname;
        insertData.link = data.nickname;
    }

    let response = {
        message: 'Profile updated'
    };


    // at least there is one parameter to be updated
    if (Object.keys(insertData).length != 0) {
        await mysql.query("UPDATE user SET ? WHERE userId = ?", [insertData, user.id]);
    }

    if (data.photo != undefined) {
        // generate s3 signed url
        response.photoUrls = [];

        for (let size of [25, 36, 42, 50, 200]) {
            let photoUrl = s3WebUsers.getSignedUrl('putObject', {
                Bucket: process.env.S3_BUCKET_PUBLIC,
                Key: `media/profile/${user.id}/photo${size}.jpg`,
                Expires: parseInt(process.env.SIGNEDURL_EXPIRATION),
                ContentType: 'image/jpeg'
            });
            response.photoUrls.push(photoUrl);
        }
    }

    if (data.header != undefined) {
        // generate s3 signed url
        response.headerUrl = s3WebUsers.getSignedUrl('putObject', {
            Bucket: process.env.S3_BUCKET_PUBLIC,
            Key: `media/profile/${user.id}/back.jpg`,
            Expires: parseInt(process.env.SIGNEDURL_EXPIRATION),
            ContentType: 'image/jpeg'
        });
    }

    return {
        code: 200,
        body: response
    };
}

module.exports.sendResetPasswordEmail = async function (event) {
    const mysql = event.mysql;

    // get query string properties
    const {
        email
    } = event.queryStringParameters || {};

    let rows = await mysql.query("SELECT userId, mail, passRestart FROM user WHERE mail = ?", [email]);
    if (!rows.length) {
        return {
            code: 404,
            body: {
                code: "US024",
            }
        };
    }

    let user = rows[0];
    let code = user.passRestart;

    if (user.passRestart.toString().length > 6) {
        code = Math.floor(Math.random() * 900000) + 100000;
        await mysql.query("UPDATE user SET passRestart = ? WHERE mail = ?", [code, email]);
    }

    let data = {
        "recipients": [user.mail],
        "subject": "Restablece tu contraseña de Wuolah",
        "template": "https://s3-eu-west-1.amazonaws.com/wuolah-public/mail/templates/es/account/forget_password.html",
        "footerTemplate": "http://s3-eu-west-1.amazonaws.com/wuolah-public/mail/templates/es/footer_template.html",
        "templateData": {
            "email": user.mail,
            "restartCode": code
        },
        "tag": "account",
        "testMode": process.env.LAMBDAVERSION == 'dev' &&
            !user.mail.includes("@wuolah.com")
    }
    await sendEmail(data, event);

    let msg = JSON.parse(JSON.stringify("Se ha enviado un correo a <EMAIL>. Por favor, revisa tu bandeja de entrada"));
    msg = msg.replace(/<EMAIL>/g, email);
    return {
        code: 200,
        body: {
            message: msg
        }
    };
};

module.exports.blockUser = async function (event) {
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
            code: "US012"
        }
    };
    const blockedUserId = data.blockedUserId;
    const unblock = data.unblock || false;

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    let userId = user.id;

    if (userId == blockedUserId || !blockedUserId) {
        return {
            code: 400,
            body: {
                code: "US025"
            }
        };
    }
    let rows = await mysql.query(`SELECT * FROM user WHERE userId = ?;`, blockedUserId);
    if (!rows.length) {
        return {
            code: 400,
            body: {
                code: "US026"
            }
        };
    }

    let msg;
    if (unblock) {
        rows = await mysql.query(`SELECT * FROM user_block WHERE userId = ? AND blockedUserId = ?;`, [userId, blockedUserId]);
        if (!rows.length) {
            return {
                code: 404,
                body: {
                    code: "US027"
                }
            };
        }

        await mysql.query(`DELETE FROM user_block WHERE userId = ? AND blockedUserId = ?;`, [userId, blockedUserId]);
        msg = 'unblock';
    } else {
        rows = await mysql.query(`SELECT * FROM user_block WHERE userId = ? AND blockedUserId = ?;`, [userId, blockedUserId]);
        if (rows.length) {
            result = {
                code: 409,
                body: {
                    code: "US028"
                }
            };
        }

        await mysql.query(`INSERT INTO user_block SET userId = ?, blockedUserId = ?;`, [userId, blockedUserId]);
        msg = 'block';
    }

    return {
        code: 200,
        body: {
            message: `User ${msg}`
        }
    };
};

module.exports.createStudentStudy = async function (event) {
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
            code: "US012"
        }
    };
    const studyType = data.studyType || 0;
    const centerId = data.centerId;
    const studyId = data.studyId;
    const course = data.course || 1;
    let def = data.default || 0;
    let reset = data.reset || false;

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    let userId = user.id;

    // begin transaction
    let connection = await mysql.beginTransaction();
    try {
        // the center has to be the same the user is registered in.
        rows = await connection.query("SELECT * FROM student_study WHERE userId = ? FOR UPDATE;", [userId]);

        if (rows.length) {

            // check if user has already this studies
            if (rows.some(s => s.centerId == centerId && s.studyId == studyId && s.course == course)) {
                connection.rollback();
                return {
                    code: 409,
                    body: {
                        code: "US029"
                    }
                };
            }

            // if user has no default study, set this as default
            def = !rows.some(study => study.default);

            if (reset || rows[0].centerId != centerId) {
                await connection.query("DELETE FROM student_study WHERE userId = ?", [userId]);
                def = 1;
            }
        } else {
            // when it's the first study to be added
            def = 1;
        }

        const data = [
            [
                userId,
                studyType,
                centerId,
                studyId,
                course,
                def
            ]
        ];

        // get dependent studies
        const dependencies = await mysql.query("SELECT * FROM study_dep WHERE (centerId = ? OR centerId IS NULL) \
                AND (studyId = ? OR studyId IS NULL) AND (studyType = ? OR studyType IS NULL) AND (course = ? OR course IS NULL)", [centerId, studyId, studyType, course]);
        dependencies
            .filter(dep => !rows.some(study => study.centerId == centerId && study.studyId == dep.dependencyId && study.course == course))
            .forEach(dep => {
                data.push([
                    userId,
                    studyType,
                    centerId,
                    dep.dependencyId,
                    course,
                    0
                ]);
            });

        await connection.query("INSERT INTO student_study (userId, type, centerId, studyId, course, `default`) VALUES ?", [data]);

        // promos
        let users = await connection.query("SELECT * FROM user WHERE userId = ? FOR UPDATE;", [userId]);
        let user = users[0];

        // only applicable to users registered in the last 30 min
        if (moment().utc().diff(moment(user.signUpDate).utc()) <= 1800000) {
            let promos = [{
                id: 'BCN01',
                condition: 'EXISTS(SELECT * FROM center WHERE center.id = ? AND center.cityId = 9)',
                params: [centerId],
                reward: 5,
                lastUserId: process.env.LAMBDAVERSION == 'dev' ? 481000 : 502300
            },
            {
                id: 'MXN01',
                condition: 'EXISTS(SELECT * FROM center WHERE center.id = ? AND center.countryId = 4)',
                params: [centerId],
                reward: 2.5,
                lastUserId: process.env.LAMBDAVERSION == 'dev' ? 614360 : 643887
            },
            {
                id: 'ITL01',
                condition: 'EXISTS(SELECT * FROM center WHERE center.id = ? AND center.countryId = 12)',
                params: [centerId],
                reward: 5,
                lastUserId: process.env.LAMBDAVERSION == 'dev' ? 614360 : 643887
            }
            ];

            for (let promo of promos) {
                if (userId > promo.lastUserId) {
                    let rows = await connection.query(`SELECT (
                    NOT EXISTS(SELECT * FROM moneyBalance WHERE moneyBalance.type IN (?) AND userId = ? LIMIT 1 FOR UPDATE) AND 
                    ${promo.condition}
                    ) AS eligible;`, [promos.map(p => p.id), userId, ...promo.params]);
                    if (rows.length && rows[0].eligible) {
                        await connection.query("UPDATE user SET money = money + ? WHERE userId = ?", [promo.reward, userId]);
                        await connection.query("INSERT INTO moneyBalance SET userId = ?, downloadUserId = 1, pvp = ?, earned = ?, correct = 0, type = ?, checked = 0", [userId, promo.reward, promo.reward, promo.id]);
                    }
                }
            }
        }

        // commit all changes and end connection
        await connection.commit();

        rows = await mysql.query(`SELECT student_study.id, student_study.centerId, student_study.studyId,
            student_study.course, student_study.default, 
            study.name AS studyName, study.visible AS studyVisible, 
            rel_center_study.courses, rel_center_study.type
            FROM student_study 
            INNER JOIN study ON study.id = student_study.studyId 
            INNER JOIN rel_center_study ON rel_center_study.centerId = student_study.centerId AND rel_center_study.studyId = student_study.studyId 
            WHERE student_study.userId = ? AND student_study.centerId = ? AND student_study.studyId = ? AND student_study.course = ?`,
            [userId, centerId, studyId, course]);

        return {
            code: 200,
            body: rows[0]
        };

    } catch (err) {
        console.log(err);
        if (connection) connection.rollback();
        throw err;
    }
};

module.exports.updateStudentStudy = async function (event) {
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
            code: "US012"
        }
    };
    const studentStudyId = event.pathParameters.studyId;
    const def = data.default || 1;

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    let userId = user.id;

    // check that student has study
    let rows = await mysql.query("SELECT * FROM student_study WHERE id = ? AND userId = ?", [studentStudyId, userId]);
    if (!rows.length) {
        return {
            code: 404,
            body: {
                code: 'US030',
            }
        };
    }

    await mysql.query("UPDATE student_study SET `default` = IF(id != ?, 0, ?) WHERE userId = ?;", [studentStudyId, def, userId]);

    return {
        code: 200,
        body: {
            message: "Studies updated"
        }
    };
};

module.exports.deleteStudentStudy = async function (event) {
    const mysql = event.mysql;

    const studentStudyId = event.pathParameters.studyId;

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    let userId = user.id;

    let connection;
    try {
        let studentStudies = await mysql.query(`SELECT student_study.id, student_study.centerId, 
            student_study.studyId, student_study.course, student_study.default, 
            study.visible 
            FROM student_study 
            INNER JOIN study ON study.id = student_study.studyId 
            WHERE student_study.userId = ?`, userId);

        const studentStudy = studentStudies.find(studentStudy => studentStudy.id == studentStudyId);
        if (!studentStudy) {
            return {
                code: 404,
                body: {
                    code: 'US031',
                }
            };
        }

        if (!studentStudy.visible || studentStudies.length <= 1) {
            return {
                code: 403,
                body: {
                    code: 'US032',
                }
            };
        }

        // begin transaction
        connection = await mysql.beginTransaction();

        await connection.query("DELETE FROM student_study WHERE id = ? AND userId = ?", [studentStudyId, userId]);

        // set default study
        if (studentStudies.length > 1 && studentStudy.default) {
            await connection.query("UPDATE student_study SET `default` = 1 WHERE userId = ? LIMIT 1;", userId);
        }

        // commit all changes and end connection
        await connection.commit();

        return {
            code: 200,
            body: {
                message: "Studies deleted",
            }
        };
    } catch (err) {
        if (connection) connection.rollback();
        throw err;
    }
}

module.exports.updateInvitationCode = async function (event) {
    const mysql = event.mysql;

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    let connection;
    try {
        let rows = await mysql.query("SELECT user.invitationCode, user.nickname FROM user WHERE user.userId = ? AND user.nickname IS NOT NULL",
            user.id);
        let code;

        if (!rows.length) {
            return {
                code: 404,
                body: {
                    code: 'US015',
                }
            };
        }

        let userData = rows[0];
        if (!userData.invitationCode) {
            // begin transaction
            connection = await mysql.beginTransaction();

            await updateUserInvitationCode(user.id, userData.nickname, connection);
            code = await connection.query('SELECT invitationCode FROM user WHERE userId = ?', user.id);
            code = code[0].invitationCode;

            // commit all changes and end connection
            await connection.commit();
        } else {
            code = userData.invitationCode;
        }

        return {
            code: 200,
            body: {
                invitationCode: code,
            }
        };
    } catch (err) {
        if (connection) connection.rollback();
        throw err;
    }

}

module.exports.getStats = async function (event) {
    const mysql = event.mysql;

    let {
        userId
    } = event.queryStringParameters || {};

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    if (!userId) userId = user.id;

    if (!userId) {
        return {
            code: 400,
            body: {
                code: 'US012',
            }
        };
    }

    let promises = [
        mysql.query("SELECT user_stats.popularity, user_stats.filesQuality, \
            user_stats.likesQuality, user_stats.org AS orgQuality \
            FROM user_stats WHERE userId = ?", [userId]),
        mysql.query("SELECT COUNT(*) AS numFiles FROM file \
            INNER JOIN upload ON upload.id = file.uploadId AND upload.deleted = 0 \
            WHERE file.userId = ? AND file.deleted = 0", [userId]),
        mysql.query("SELECT COALESCE(SUM(file.downloads + file.views), 0) AS numDownloads \
            FROM file WHERE userId = ? AND deleted = 0;", [userId]),
        mysql.query("SELECT COALESCE(SUM(userId = ?), 0) AS numFollowing, \
            COALESCE(SUM(followedId = ?), 0) AS numFollowers \
            FROM follow_user WHERE (userId = ? OR followedId = ?);", [userId, userId, userId, userId]), // numFollowing and numFollowers
    ];

    if (userId == user.id) {
        promises.push(mysql.query("SELECT IF(balance_request.balance, (user.money + user.accumulated + balance_request.balance), (user.money + user.accumulated)) AS totalGenerated \
            FROM user \
            LEFT JOIN balance_request ON user.userId = balance_request.userId AND (balance_request.status = 1 OR balance_request.status = 2) \
            WHERE user.userId = ?;", [userId]));
    }

    let values = await Promise.all(promises);

    let response = {};
    if (values.length > 0 && values[0].length) response = { ...response, ...values[0][0] };
    if (values.length > 1 && values[1].length) response = { ...response, ...values[1][0] };
    if (values.length > 2 && values[2].length) response = { ...response, ...values[2][0] };
    if (values.length > 3 && values[3].length) response = { ...response, ...values[3][0] };
    if (userId == user.id && values.length > 4 && values[4].length) response = { ...response, ...values[4][0] };

    if (!values.length) {
        return {
            code: 404,
            body: {
                code: 'US022',
            }
        };
    }

    return {
        code: 200,
        body: response
    };
};

module.exports.getUserInvitations = async function (event) {
    const mysql = event.mysql;

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    if (!user.id) {
        return {
            code: 401,
            body: {
                code: "US001"
            }
        };
    }

    // 2019-05-29 00:00:00 to 2019-06-30 23:59:59 (UTC+2)
    let sql = "SELECT COUNT(*) AS total \
        FROM invitation \
        INNER JOIN user ON user.userId = invitation.inviteeId \
        WHERE (inviterId = ? OR inviteeId = ?) AND \
        user.confirmationCode = 0 AND created BETWEEN '2019-05-28 22:00:00' AND '2019-06-30 21:59:59';";
    let rows = await mysql.query(sql, [user.id, user.id]);

    return {
        code: 200,
        body: { participations: rows[0].total }
    };
};

module.exports.getInvitationReward = async function (event) {
    const mysql = event.mysql;
    if (event.queryStringParameters && event.queryStringParameters.userId)
        userId = event.queryStringParameters.userId
    else if (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.id)
        userId = event.requestContext.authorizer.id
    else {
        return {
            code: 400,
            body: {
                code: "No user specified"
            }
        };
    }

    let data = await mysql.query("select invitationCode, partnerType, centerId from user inner join student_study on student_study.userId=user.userId where user.userId=? AND nickname IS NOT NULL limit 1", [userId])
    let user_data = data[0]
    if (!user_data) {
        return {
            code: 400,
            body: {
                code: "US034"
            }
        };
    }

    user_data.partnerType = user_data.partnerType ? user_data.partnerType : 0
    var params_current = {
        TableName: `${process.env.DYNAMODB_PREFIX}invitationRewards`,
        KeyConditionExpression: 'centerId = :c and created < :d',
        ExpressionAttributeValues: {
            ':c': user_data.centerId,
            ':d': new Date().getTime()
        },
        ScanIndexForward: false,
        Limit: 1
    };

    var params_next = {
        TableName: `${process.env.DYNAMODB_PREFIX}invitationRewards`,
        KeyConditionExpression: 'centerId = :c and created >= :d',
        ExpressionAttributeValues: {
            ':c': user_data.centerId,
            ':d': new Date().getTime()
        },
        ScanIndexForward: true,
        Limit: 1
    };

    data = await Promise.all([documentClient.query(params_current).promise(), documentClient.query(params_next).promise()])
    current = data[0]
    next = data[1]

    let result = {}
    if (current.Items.length) {
        item = current.Items[0]

        result = {
            "invitationCode": user_data.invitationCode,
            "expiration": next.Items.length ? new Date(next.Items[0].created) : moment.utc().isoWeekday(8).startOf('day'),
            "partnerType": user_data.partnerType,
            "reward": item.inviter["partnerType_" + user_data.partnerType],
            "invited_reward": item.invited["partnerType_" + user_data.partnerType]
        }
    } else {
        result = {
            "invitationCode": user_data.invitationCode,
            "expiration": moment.utc().isoWeekday(8).startOf('day'),
            "partnerType": user_data.partnerType,
            "reward": {},
            "invited_reward": {}
        }
    }

    return {
        code: 200,
        body: result
    };
}

module.exports.getInvitedInvitationRewards = async function (event) {
    const mysql = event.mysql;
    let userId;
    if (event.queryStringParameters && event.queryStringParameters.userId)
        userId = event.queryStringParameters.userId;
    else if (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.id)
        userId = event.requestContext.authorizer.id;
    else {
        return {
            code: 400,
            body: {
                code: "US035"
            }
        };
    }

    let isConfirmed
    if (event.queryStringParameters && event.queryStringParameters.isConfirmed === "0")
        isConfirmed = 0;
    else if (event.queryStringParameters && event.queryStringParameters.isConfirmed === "1")
        isConfirmed = 1;

    let limit = (event.queryStringParameters && event.queryStringParameters.limit) ? event.queryStringParameters.limit : 50;
    let offset = (event.queryStringParameters && event.queryStringParameters.offset) ? event.queryStringParameters.offset : 0;


    // calculate total

    let columns = [
        "(SELECT COUNT(DISTINCT inviteeId) FROM invitation WHERE inviterId = ?) AS total",
        "COUNT(DISTINCT inviteeId) - SUM(user.confirmationCode != 0) AS confirmed",
        "SUM(invitation.popularity) AS popularity",
        "SUM(invitation.premiumDownloads) AS premiumDownloads",
        "SUM(invitation.money) AS money",
        "SUM(invitation.tickets) AS tickets"
    ];
    let table = "invitation";
    let joins = [
        "INNER JOIN user ON user.userId = invitation.inviteeId"
    ];
    let conditions = ["inviterId = ?", "user.confirmationCode = 0", "user.nickname IS NOT NULL"];
    let params = [userId, userId, Number(limit), Number(offset)];
    let count = await mysql.query(`SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`, params);


    // calculate data

    columns = [
        "invitation.popularity", "invitation.money", "invitation.premiumDownloads", "invitation.tickets",
        "IF(user.confirmationCode = 0, 1, 0) AS isConfirmed",
        "seg_university.name", "invitation.inviteeId AS userId", "user.nickname"
    ];
    table = "invitation";
    joins = [
        "LEFT JOIN student_study ON invitation.inviteeId = student_study.userId AND student_study.default = 1",
        "LEFT JOIN center ON center.id = student_study.centerId",
        "LEFT JOIN user ON invitation.inviteeId = user.userId",
        "LEFT JOIN seg_university ON seg_university.id = center.universityId"
    ];
    conditions = ["invitation.inviterId = ?"];
    params = [userId, Number(limit), Number(offset)];

    if (isConfirmed === 1) {
        conditions.push("confirmationCode = 0", "user.nickname IS NOT NULL");
    } else {
        if (isConfirmed === 0) conditions.push("confirmationCode != 0");
    }

    let data = await mysql.query(`SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")} LIMIT ? OFFSET ?`, params);

    let result = {
        "total": {
            "registered": count[0].total,
            "confirmed": count[0].confirmed ? count[0].confirmed : 0,
            "rewards": {
                "popularity": count[0].popularity ? count[0].popularity : 0,
                "money": count[0].money ? count[0].money : 0,
                "premiumDownloads": count[0].premiumDownloads ? count[0].premiumDownloads : 0,
                "tickets": count[0].tickets ? count[0].tickets : 0
            }
        },
        "data": []
    }

    let obj
    for (let i = 0; i < data.length; i++) {
        obj = {
            "user": {
                "userId": data[i].userId,
                "isConfirmed": data[i].isConfirmed ? true : false
            },
            "rewards": {}
        }

        if (data[i].university_name)
            obj.user.university_name = data[i].university_name
        if (data[i].name)
            obj.user.name = data[i].name
        if (data[i].nickname)
            obj.user.nickname = data[i].nickname

        if (data[i].popularity)
            obj.rewards.popularity = data[i].popularity
        if (data[i].money)
            obj.rewards.money = data[i].money
        if (data[i].tickets)
            obj.rewards.tickets = data[i].tickets
        if (data[i].premiumDownloads)
            obj.rewards.premiumDownloads = data[i].premiumDownloads

        result.data.push(obj)
    }

    return {
        code: 200,
        body: result
    };
}


/**
 * Helper methods
 */

function getFoldersByUploads(version, uploads) {
    let results = [];
    if (version == 1) {
        uploads.forEach(upload => {
            let study = results.find(study => study.centerId == upload.centerId && study.studyId == upload.studyId && study.course == upload.course);
            let newStudy = study == undefined;
            if (!study) {
                study = {
                    centerId: upload.centerId,
                    studyId: upload.studyId,
                    studyName: upload.studyName,
                    universityName: upload.universityName,
                    course: upload.course,
                    folders: []
                }
            }

            let folder = study.folders.find(folder => folder.folderId == upload.folderId && folder.centerId == upload.centerId && folder.studyId == upload.studyId);
            let newFolder = folder == undefined;
            if (!folder) {
                folder = {
                    folderId: upload.folderId,
                    folderName: upload.folderName,
                    centerId: upload.centerId,
                    studyId: upload.studyId,
                    fav: upload.fav,
                    relationId: upload.relationId,
                    numFiles: 0
                }
            }

            folder.numFiles += upload.numFiles;
            if (newFolder) study.folders.push(folder);
            if (newStudy) results.push(study);
        });
    } else {
        uploads.forEach(upload => {
            let center = results.find(result => result.centerId == upload.centerId);
            let newCenter = center == undefined;
            if (newCenter) {
                center = {
                    centerId: upload.centerId,
                    centerName: upload.centerName,
                    universityName: upload.universityName,
                    studies: [],
                    numFiles: upload.numFiles
                }
            } else {
                center.numFiles += upload.numFiles;
            }

            let study = center.studies.find(study => study.studyId == upload.studyId);
            let newStudy = study == undefined;
            if (newStudy) {
                study = {
                    studyId: upload.studyId,
                    studyName: upload.studyName,
                    courses: [],
                    numFiles: upload.numFiles
                }
            } else {
                study.numFiles += upload.numFiles;
            }

            let course = study.courses.find(course => course.course == upload.course);
            let newCourse = course == undefined;
            if (newCourse) {
                course = {
                    course: upload.course,
                    folders: [],
                    numFiles: upload.numFiles
                }
            } else {
                course.numFiles += upload.numFiles;
            }

            let folder = course.folders.find(folder => folder.folderId == upload.folderId);
            let newFolder = folder == undefined;
            if (newFolder) {
                folder = {
                    folderId: upload.folderId,
                    folderName: upload.folderName,
                    fav: upload.fav,
                    relationId: upload.relationId,
                    verified: upload.folderVerified,
                    numFiles: 0
                }
            }

            folder.numFiles += upload.numFiles;
            if (newFolder) {
                course.folders.push(folder);
                course.folders.sort((f1, f2) => {
                    if (f1.folderName.toLowerCase() < f2.folderName.toLowerCase()) return -1;
                    if (f1.folderName.toLowerCase() > f2.folderName.toLowerCase()) return 1;
                    return 0;
                });
            }
            if (newCourse) {
                study.courses.push(course);
                study.courses.sort((c1, c2) => c1.course - c2.course);
            }
            if (newStudy) {
                center.studies.push(study);
            }
            center.studies.sort((s1, s2) => s2.numFiles - s1.numFiles);

            if (newCenter) results.push(center);
        });

        results.sort((c1, c2) => c2.numFiles - c1.numFiles);
    }

    return results;
}

async function sendConfirmationEmail(userId, email, connection) {

    let conditions = [], params = [];
    if (userId != null) {
        conditions = ["userId = ?"];
        params.push(userId);
    } else if (email != null) {
        conditions = ["mail = ?"];
        params.push(email);
    } else {
        return {
            code: 400,
            body: {
                message: "Missing required parameters"
            }
        };
    }

    let rows = await connection.query(`SELECT userId, mail, confirmationCode FROM user WHERE ${conditions.join(" AND ")} ;`, params);

    if (!rows.length) {
        return {
            code: 409,
            body: {
                message: "User not found"
            }
        };
    } else if (rows.length > 1) {
        let email = rows[0].mail;
        return {
            code: 409,
            body: {
                message: "There are several accounts for this user"
            }
        };
    }

    let user = rows[0];

    if (user.confirmationCode == undefined || user.confirmationCode == null) {
        return {
            code: 500,
            body: {
                message: `User #${user.userId} has no confirmation code`
            }
        };
    } else if (user.confirmationCode == 0) {
        return {
            code: 400,
            body: {
                message: "This account has already been verified."
            }
        };
    }

    let lastPetitons = await connection.query('SELECT count(*) as nCount FROM confirmation_mail WHERE userId = ? AND created > date_sub(curdate(), interval 1 day);', user.userId);

    if (lastPetitons.length && lastPetitons[0].nCount >= 5) {
        return {
            code: 429,
            body: {
                code: "US011"
            }
        };
    }

    await connection.query('INSERT INTO confirmation_mail SET userId = ?;', user.userId);

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
    return await sendEmail(data);
}

async function sendEmail(data) {
    const params = {
        Message: JSON.stringify(data),
        TopicArn: process.env.TOPIC_MAILING
    };

    const response = await sns.publish(params).promise();
    return response;
}

const giveInvitationRewards = async function (inviteeId, connection, event) {

    //Invitation rewards time!
    let invitation_info = await connection.query("select invitation.inviteeId, invitation.inviterId, invitation.created, student_study.centerId, user.partnerType from invitation inner join student_study on student_study.userId = invitation.inviterId inner join user on user.userId=invitation.inviterId where inviteeId = ? AND user.nickname IS NOT NULL limit 1", [inviteeId]);
    let rewards = {
        "rewards": {}
    }

    if (invitation_info.length) {
        let inviter = invitation_info[0].inviterId
        let invited = invitation_info[0].inviteeId
        let invitation_date = new Date(invitation_info[0].created).getTime()
        let centerId = invitation_info[0].centerId
        let partnerType = invitation_info[0].partnerType ? invitation_info[0].partnerType : 0

        //Ya tenemos los datos del invitador, invitado, centro del invitador y grado de contribucion del invitador
        //Sólo debemos acceder a las recompensas (que dependen del centro y grado de contribucion)

        var params = {
            TableName: `${process.env.DYNAMODB_PREFIX}invitationRewards`,
            KeyConditionExpression: 'centerId = :c and created <= :d',
            ExpressionAttributeValues: {
                ':c': centerId,
                ':d': invitation_date
            },
            ScanIndexForward: false,
            Limit: 1
        };

        let center_rewards = await documentClient.query(params).promise()

        if (!center_rewards.Items || !center_rewards.Items.length) return rewards;

        let inviter_rewards = center_rewards.Items[0].inviter["partnerType_" + partnerType]
        let invited_rewards = center_rewards.Items[0].invited["partnerType_" + partnerType]

        await Promise.all([reward(inviter, invited, inviter_rewards, connection, event), reward(invited, inviter, invited_rewards, connection, event)])
        rewards = {
            "rewards": invited_rewards
        }
    }
    return rewards;
}

const reward = async (receiver, generator, rewards, connection, event) => {
    let promises = [];

    if (rewards.popularity) {
        //insert log
        promises.push(connection.query("insert into user_popularity(userId,recipientId,type,popularity,created) values (?,?,'USER_INVITATION_REWARD',?,?)", [generator, receiver, rewards.popularity, new Date()]))
        //set global
        promises.push(connection.query("update user set popularity=popularity+? where userId=?", [rewards.popularity, receiver]));
    }

    if (rewards.premiumDownloads) {
        //insert log
        let ddb_item = {
            "userId": receiver,
            "invitationUserId": generator,
            "quantity": rewards.premiumDownloads,
            "insertDate": new Date().getTime()
        }
        let params = {
            "Item": ddb_item,
            "TableName": `${process.env.DYNAMODB_PREFIX}premiumDownloads`,
        }

        promises.push(documentClient.put(params).promise())

        //set global
        promises.push(connection.query("update user set premiumDownloads=premiumDownloads+? where userId=?", [rewards.premiumDownloads, receiver]))
    }

    if (rewards.tickets) {
        //insert tickets
        for (let i = 0; i < rewards.tickets; i++)
            promises.push(connection.query("insert into giveaway_ticket(userId,invitedUserId,created) values (?,?,?)", [receiver, generator, new Date()]))

    }

    if (rewards.money) {
        //insert log
        promises.push(connection.query("INSERT INTO moneyBalance (userId, downloadUserId, pvp, earned, type, dateTime, ip) VALUES (?, 1, ?, ?, ?, NOW(), 0)", [receiver, rewards.money, rewards.money, 'INVIT']))
        //set global
        promises.push(connection.query("UPDATE user SET money = money + ? WHERE userId = ?", [rewards.money, receiver]))
    }

    return promises
}

async function updateUserInvitationCode(userId, nickname, connection) {
    let invitationCode = await generateInvitationCode(nickname, connection);
    await connection.query("UPDATE user SET invitationCode = ? WHERE userId = ? ", [invitationCode, userId]);
}

async function generateInvitationCode(nickname, connection, index = 0) {
    // substracts a random character until the length is 5 or less, then complete with digits
    let code = shortenNickname(nickname, index);
    code = code + Math.floor(Math.random() * (Math.pow(10, (6 - code.length)) - 1));

    // if it exists, decrease the number of letters and increase the number of digits and retry
    let rows = await connection.query("SELECT user.* FROM user WHERE user.invitationCode = ?", code);
    if (!rows.length) return code;
    return await generateInvitationCode(nickname, connection, index + 1);
}

function shortenNickname(nickname, index) {
    let substracted;
    if (nickname.length > Math.max(5 - index, 2)) {
        substracted = Math.floor(Math.random() * (nickname.length - 2)) + 1;
        nickname = nickname.slice(0, substracted) + nickname.slice(substracted + 1);
        return shortenNickname(nickname, index);
    } else {
        return nickname;
    }
}

async function uploadDefaultProfilePicture(userId, event) {
    const index = (userId % 7) + 1;
    let promises = [];
    for (let size of [25, 36, 42, 50, 200]) {
        let promise = s3.copyObject({
            Bucket: process.env.S3_BUCKET_PUBLIC,
            Key: `media/profile/${userId}/photo${size}.jpg`,
            CopySource: `/${process.env.S3_BUCKET_PUBLIC}/media/profile/default/profile${index}-${size}.jpg`
        }).promise();
        promises.push(promise);
    }
    await Promise.all(promises);
}

//Valida si un string tiene formato de email example@wuolah.com
function validateEmail(email) {
    var re = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
    return re.test(email);
}