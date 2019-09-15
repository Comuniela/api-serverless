const request = require("request-promise");
const AWS = require("aws-sdk");
const s3 = new AWS.S3();
const qs = require('qs');
const moment = require('moment');
const sns = new AWS.SNS();

module.exports.searchFiles = async function (event) {
    const mysql = event.mysql;
    // get query string properties
    const {
        userId,
        name,
        uploadId,
        countryId,
        centerId,
        studyId,
        course,
        folderId,
        category,
        sort,
        limit = 10,
        offset = 0
    } = event.queryStringParameters || {};
    const downloaded = event.queryStringParameters ? JSON.parse(event.queryStringParameters.downloaded || null) : null;
    const deleted = event.queryStringParameters ? JSON.parse(event.queryStringParameters.deleted || null) : null;

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    let columns = ["file.*",
        `IF(!file.anonymous OR file.userId = ${user.id}, file.userId, NULL) AS userId`,
        `IF(!file.anonymous OR file.userId = ${user.id}, user.nickname, NULL) AS userNickname`,
        `IF(!file.anonymous OR file.userId = ${user.id}, user.popularity, NULL) AS userPopularity`,
        `IF(!file.anonymous OR file.userId = ${user.id}, user.money, NULL) AS userMoney`,
        `IF(!file.anonymous OR file.userId = ${user.id}, user.link, NULL) AS userLink`,
        `IF(file.userId = ${user.id}, file.money, NULL) AS money`,
        "NULL AS hiddenDirectory", "NULL AS hiddenFile",
        "folder.link AS folderLink", "folder.name AS folderName", "folder.shortName AS folderShortName",
        "center.name AS centerName", "center.nameLink AS centerLink", "center.shortName AS centerShortName",
        "study.name AS studyName", "rel_center_study.courses",
        "upload.teacher", "upload.category",
        "upload.title AS uploadTitle", "upload.titleLink AS uploadLink",
        "seg_university.name AS universityName", "seg_university.shortName AS universityShortName"
    ];
    let tables = ["file"];
    let joins = [
        "INNER JOIN folder ON folder.id = file.folderId",
        "INNER JOIN center ON center.id = file.centerId",
        "INNER JOIN study ON study.id = file.studyId",
        "INNER JOIN rel_center_study ON rel_center_study.centerId = file.centerId AND rel_center_study.studyId = file.studyId",
        "INNER JOIN user ON user.userId = file.userId",
        "INNER JOIN upload ON upload.id = file.uploadId",
        "LEFT JOIN seg_university ON seg_university.id = center.universityId",
        "LEFT JOIN user_banned ON user_banned.userId = file.userId"
    ];
    let conditions = [`(user_banned.userId IS NULL OR user_banned.bupload = 0 OR file.userId = ${user.id})`];
    let params = [];
    let orderBy = "ORDER BY file.id";

    // authenticated call, return if file is bookmarked
    if (user.id) {
        columns.push("IF(follow_file.id IS NULL, FALSE, TRUE) AS bookmarked");
        joins.push("LEFT JOIN follow_file ON follow_file.followedId = file.id AND follow_file.userId = ?");
        params.push(user.id);
    }

    if (userId != null) {
        // if user is not the authenticated user, don't return anonymous files
        if (userId != user.id) {
            conditions.push("file.anonymous = 0", "upload.anonymous = 0", "file.userId = ?");
            params.push(userId);
        } else {
            if (downloaded) {
                joins.push("INNER JOIN downloads ON downloads.fileId = file.id");
                conditions.push("downloads.userId = ?");
                params.push(userId);
            } else {
                conditions.push("file.userId = ?");
                params.push(userId);
            }
        }
    }

    if (name != null) {
        conditions.push(`(file.name LIKE ? OR upload.title LIKE ? OR file.category LIKE ? OR file.teacher LIKE ? OR ((!file.anonymous OR (file.userId = ${user.id} OR ${user.role} = 2)) AND user.nickname LIKE ?))`);
        params.push(`%${name}%`, `%${name}%`, `%${name}%`, `%${name}%`, `%${name}%`);
    }
    if (uploadId != null) {
        conditions.push("file.uploadId = ?");
        params.push(uploadId);
    }
    if (countryId != null) {
        conditions.push("center.countryId = ?");
        params.push(countryId);
    }
    if (centerId != null) {
        // check if center belongs to latam
        let rows = await mysql.query("SELECT * FROM center WHERE id = ?", centerId);
        let center = rows.length ? rows[0] : null;
        let latamIds = [2, 3, 4, 5, 6];
        if (center && latamIds.includes(center.countryId)) {
            conditions.push("center.universityId = ?");
            params.push(center.universityId);
        } else {
            conditions.push("file.centerId = ?");
            params.push(centerId);
        }
    }
    if (studyId != null) {
        conditions.push("file.studyId = ?");
        params.push(studyId);
    }
    if (course != null) {
        conditions.push("file.course = ?");
        params.push(course);
    }
    if (folderId != null) {
        conditions.push("file.folderId = ?");
        params.push(folderId);
    }
    if (category != null) {
        conditions.push("file.category = ?");
        params.push(category);
    }
    if (deleted != null) {
        conditions.push("file.deleted = ?");
        params.push(deleted);
    }

    if (sort != null) {
        if (sort == "date") {
            orderBy = "ORDER BY file.uploadDate ASC";
        } else if (sort == "-date") {
            orderBy = "ORDER BY file.uploadDate DESC";
        } else if (sort == "deletedDate") {
            orderBy = "ORDER BY file.deletedDate ASC";
        } else if (sort == "-deletedDate") {
            orderBy = "ORDER BY file.deletedDate DESC";
        } else if (sort == "downloads") {
            orderBy = "ORDER BY (file.downloads + file.views) ASC ";
        } else if (sort == "-downloads") {
            orderBy = "ORDER BY (file.downloads + file.views) DESC ";
        }
    }

    let sql = `SELECT ${columns} FROM ${tables} ${joins.join(" ")} WHERE ${conditions.join(" AND ")} ${orderBy} LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));

    const rows = await mysql.query(sql, params);
    return {
        code: 200,
        body: rows
    };
}

module.exports.getFileById = async function (event) {
    const mysql = event.mysql;
    // get query string properties
    const {
        fileId
    } = event.pathParameters || {};

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    let columns = ["file.*",
        `IF(!file.anonymous OR file.userId = ${user.id}, file.userId, NULL) AS userId`,
        `IF(!file.anonymous OR file.userId = ${user.id}, user.nickname, NULL) AS userNickname`,
        `IF(!file.anonymous OR file.userId = ${user.id}, user.popularity, NULL) AS userPopularity`,
        `IF(!file.anonymous OR file.userId = ${user.id}, user.money, NULL) AS userMoney`,
        `IF(!file.anonymous OR file.userId = ${user.id}, user.link, NULL) AS userLink`,
        `IF(file.userId = ${user.id}, file.money, NULL) AS money`,
        "NULL AS hiddenDirectory", "NULL AS hiddenFile",
        "folder.link AS folderLink", "folder.name AS folderName",
        "center.name AS centerName", "center.nameLink AS centerLink",
        "study.name AS studyName", "rel_center_study.courses",
        "upload.teacher", "upload.category",
        "upload.title AS uploadTitle", "upload.titleLink AS uploadLink",
        "seg_university.name AS universityName"
    ];
    let tables = ["file"];
    let joins = [
        "INNER JOIN folder ON folder.id = file.folderId",
        "INNER JOIN center ON center.id = file.centerId",
        "INNER JOIN study ON study.id = file.studyId",
        "INNER JOIN rel_center_study ON rel_center_study.centerId = file.centerId AND rel_center_study.studyId = file.studyId",
        "INNER JOIN user ON user.userId = file.userId",
        "LEFT JOIN seg_university ON seg_university.id = center.universityId",
        "LEFT JOIN upload ON upload.id = file.uploadId",
        "LEFT JOIN user_banned ON user_banned.userId = file.userId"
    ];
    let conditions = [`(user_banned.userId IS NULL OR user_banned.bupload = 0 OR file.userId = ${user.id})`];
    let params = [];

    // authenticated call, return if file is bookmarked
    if (user.id) {
        columns.push("IF(follow_file.id IS NULL, FALSE, TRUE) AS bookmarked");
        joins.push("LEFT JOIN follow_file ON follow_file.followedId = file.id AND follow_file.userId = ?");
        params.push(user.id);
    }

    conditions.push("file.id = ?");
    params.push(fileId);

    let sql = `SELECT ${columns} FROM ${tables} ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;

    const rows = await mysql.query(sql, params);
    if (!rows.length) {
        return {
            code: 404,
            body: {
                code: "FI002"
            }
        }
    }

    return {
        code: 200,
        body: rows[0]
    };
}

module.exports.getFileLikes = async function (event) {
    const mysql = event.mysql;
    // get query string properties
    const {
        fileId
    } = event.pathParameters || {};

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    let sql = `SELECT file_like.*, user.nickname AS nickname, user.link AS link 
    FROM file_like, user WHERE file_like.fileId = ? AND user.userId = file_like.userId;`;
    let params = [fileId];
    let rows = await mysql.query(sql, params);

    return {
        code: 200,
        body: rows
    };
}

module.exports.downloadFile = async function (event, type) {
    const mysql = event.mysql;

    // body params
    let data;
    if (event.headers['Content-Type'] == 'application/x-www-form-urlencoded') {
        data = qs.parse(event.body || null);
    } else {
        data = JSON.parse(event.body || null);
    }

    const premium = data && data.premium != undefined ? Number(data.premium) : 0;
    const captcha = data && data.captcha != undefined ? data.captcha : null;

    // path params
    const {
        fileId = null
    } = event.pathParameters || {};
    if (fileId == null) {
        return {
            code: 400,
            body: {
                code: 'FI003'
            }
        };
    }

    // user
    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    const userId = user.id;


    let rows = await mysql.query("SELECT * FROM user WHERE userId = ?", userId);
    if (!rows.length || rows[0].confirmationCode != 0) {
        return {
            code: 403,
            body: {
                code: 'FI004'
            }
        };
    }

    let mode = (type == 0) ? 'VIEW_FILE' : 'DOWNLOAD_FILE';
    const options = {
        token: event.headers.Authorization,
        premium,
        captcha,
        remoteIp: event.requestContext.identity.sourceIp,
        mode: mode
    };

    let connection;
    try {
        const {
            token,
            premium,
            captcha,
            remoteIp,
            mode
        } = options;

        rows = await mysql.query(`SELECT file.*, center.countryId, center.cityId, center.universityId FROM file 
            INNER JOIN center ON center.id = file.centerId
            WHERE file.id = ? AND file.deleted = 0 AND file.s3 = 1;`, fileId);
        if (!rows.length) {
            return {
                code: 400,
                body: {
                    code: "FI005"
                }
            };
        };
        let file = rows[0];

        const user = await getUser(mysql, userId);

        // check user banned
        if (!user || user.bglobal) {
            return {
                code: 403,
                body: {
                    code: "FI006",
                }
            };
        };

        if (premium && user.premiumDownloads <= 0) {
            return {
                code: 403,
                body: {
                    code: "FI007",
                }
            };
        }

        // begin transaction
        connection = await mysql.beginTransaction();

        if (user.captchaCounter <= 0) {
            if (captcha) {
                const secretKeys = [process.env.CAPTCHA_SECRETKEY, process.env.CAPTCHA_SECRETKEYMOBILE];

                let success = false;
                for (let secretKey of secretKeys) {
                    try {
                        const verificationURL = `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${captcha}&remoteip=${remoteIp}`;
                        const body = await request({
                            url: verificationURL,
                            json: true
                        });
                        success = body.success;
                        if (success) break;
                    } catch (err) {
                        success = false;
                    }
                }

                if (success) {
                    const newCaptchaCount = Math.floor(Math.random() * (11) + 10);
                    await connection.query("UPDATE user SET captchaCounter = ? WHERE userId = ?;", [newCaptchaCount, userId]);
                } else {
                    connection.rollback();
                    return {
                        code: 429,
                        body: {
                            code: "FI009",
                        }
                    };
                }
            } else {
                connection.rollback();
                return {
                    code: 429,
                    body: {
                        code: "FI008",
                    }
                };
            }
        }

        let response;
        if (file.corrupt >= 10) {
            const source = `${process.env.S3_BUCKET_MEDIA}/media/docs/${file.hiddenDirectory}/${file.hiddenFile}`;
            const destBucket = process.env.S3_BUCKET_PUBLIC;
            const destKey = `media/premium/${file.hiddenFile}`;
            response = await copyFile(source, destBucket, destKey, file.fileType);
        } else {
            // check if file exists in S3
            const exists = await checkFile(process.env.S3_BUCKET_MEDIA, `media/docs/${file.hiddenDirectory}/${file.hiddenFile}`);

            if (exists) {
                // file found in s3

                // if file is pdf, send it to api-php to generate it
                if (file.fileType == "application/pdf") {
                    // if file is pdf, generate pdf
                    response = await request({
                        url: `${process.env.APIPHPENDPOINT}/v3/pdf/${mode == 'VIEW_FILE' ? 'view' : 'download'}/${fileId}/${premium}`,
                        method: 'POST',
                        json: true,
                        headers: {
                            "Authorization": token
                        }
                    });
                } else {
                    // copy file from original bucket to premium bucket
                    const source = `${process.env.S3_BUCKET_MEDIA}/media/docs/${file.hiddenDirectory}/${file.hiddenFile}`;
                    const destBucket = process.env.S3_BUCKET_PUBLIC;
                    const destKey = `media/premium/${file.hiddenFile}`;
                    response = await copyFile(source, destBucket, destKey, file.fileType);
                }
            } else {
                if (file.fileType == "application/pdf") {
                    await deleteS3File(connection, file);
                }
                connection.rollback();
                return {
                    code: 404,
                    body: {
                        code: "FI010",
                    }
                };
            }
        }

        // check user banned
        if (user && !user.bdownload && !user.bglobal) {
            // update file downloads
            await updateDownloads(connection, userId, file, mode, premium);

            // set popularity
            await setPopularity(connection, userId, file.userId, mode, fileId, 1);

            // pay user
            if (file.fileType == "application/pdf") {
                await payUser(event, connection, userId, file, mode, premium);
            }
        }

        // commit all changes and end connection
        await connection.commit();

        // add file extension (bug filenames)
        response.extension = file.extension;

        return {
            code: 200,
            body: response
        };
    } catch (err) {
        if (connection) connection.rollback();
        if (err.error && err.error.code && err.error.message) {
            return {
                code: err.error.code,
                body: {
                    message: err.error.message,
                }
            };
        } else {
            throw err;
        }
    }
};

module.exports.getThumbnail = async function (event) {
    const mysql = event.mysql;

    // path params
    const {
        fileId = null
    } = event.pathParameters || {};

    try {
        let rows = await mysql.query("SELECT extension FROM file WHERE id = ? AND deleted = 0 AND s3 = 1;", fileId);
        if (!rows.length)
            return {
                code: 400,
                body: {
                    code: "FI011"
                }
            };

        const file = rows[0];

        const fileExt = file.extension.toLowerCase();

        if (fileExt != "pdf") {
            return {
                code: 400,
                body: {
                    code: "FI012"
                }
            };
        }

        let thumbnailUrl = await request({
            url: `${process.env.APIPHPENDPOINT}/v3/pdf/thumbnail/${fileId}`,
            method: 'GET'
        });

        return {
            code: 200,
            body: thumbnailUrl
        };
    } catch (err) {
        if (err.error && err.error.code && err.error.message) {
            return {
                code: err.error.code,
                body: {
                    message: err.error.message,
                }
            };
        } else {
            throw err;
        }
    }
};

module.exports.previewFile = async function (event) {
    const mysql = event.mysql;

    // query params
    let {
        fileId
    } = event.pathParameters || {};
    fileId = Number(fileId);

    // user
    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    let userId = user.id;

    let connection;
    try {
        const user = userId ? await getUser(mysql, userId) : null;

        let rows = await mysql.query(`SELECT file.*, center.countryId, center.cityId, center.universityId FROM file 
            INNER JOIN center ON center.id = file.centerId
            WHERE file.id = ? AND file.deleted = 0 AND file.s3 = 1;`, fileId);
        if (!rows.length) return {
            code: 404,
            body: {
                code: "FI013"
            }
        };
        let file = rows[0];

        let response;

        // begin transaction
        connection = await mysql.beginTransaction();

        // check if file already exists
        try {
            response = await getFile(process.env.S3_BUCKET_PUBLIC, `media/previews/${file.id}`);
        } catch (err) {
            if (err.statusCode != 404) throw err;

            // check if file exists in S3
            const exists = await checkFile(process.env.S3_BUCKET_MEDIA, `media/docs/${file.hiddenDirectory}/${file.hiddenFile}`);

            if (exists) {
                // file found in s3
                if (file.fileType == "application/pdf") {
                    // if file is pdf, generate pdf
                    response = await request({
                        url: `${process.env.APIPHPENDPOINT}/v3/pdf/preview/${file.id}`,
                        method: 'POST',
                        json: true
                    });
                } else {
                    // copy file from original bucket to public bucket
                    const source = `${process.env.S3_BUCKET_MEDIA}/media/docs/${file.hiddenDirectory}/${file.hiddenFile}`;
                    const destBucket = process.env.S3_BUCKET_PUBLIC;
                    const destKey = `media/previews/${file.id}`;
                    response = await copyFile(source, destBucket, destKey, file.fileType);
                }

            } else {
                if (file.fileType == "application/pdf") {
                    await deleteS3File(connection, file);
                }
                connection.rollback();
                return {
                    code: 404,
                    body: {
                        code: "FI014"
                    }
                };
            }
        }

        // check user banned
        if (!user || (user && !user.bdownload && !user.bglobal)) {
            // update file previews
            await updatePreviews(userId, file, connection);

            // set popularity
            if (user) await setPopularity(connection, userId, file.userId, 'PREVIEW_FILE', file.id, 1);
        }

        // commit all changes and end connection
        await connection.commit();

        // attach information for preview scroll
        response.uploadId = file.uploadId;
        response.fileId = file.id;

        return {
            code: 200,
            body: response
        };
    } catch (err) {
        if (connection) connection.rollback();
        if (err.error && err.error.code && err.error.message) {
            return {
                code: err.error.code,
                body: {
                    message: err.error.message
                }
            };
        } else {
            console.log(err);
            throw err;
        }
    }
};

module.exports.deleteFile = async function (event) {
    const mysql = event.mysql;

    // body params
    let data = {};
    if (event.headers['Content-Type'] == 'application/x-www-form-urlencoded') {
        data = qs.parse(event.body || null);
    } else {
        data = JSON.parse(event.body || null);
    }
    if (!data) return {
        code: 400,
        body: {
            code: "FI001"
        }
    };
    const copyright = JSON.parse(data.copyright || null) || false;
    const removeMoney = JSON.parse(data.removeMoney || null) || false;
    const comments = data.comments;
    const s3 = data.s3;

    // path params
    let {
        fileId = null
    } = event.pathParameters || {};
    fileId = Number(fileId);
    if (fileId == null) {
        return {
            code: 400,
            body: {
                code: 'FI015'
            }
        };
    }

    // user
    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    const userId = user.id;

    let connection;
    try {
        let user = await getUser(mysql, userId);
        let file = await getFileById(mysql, userId, fileId);
        if (file.userId != userId && (user && user.role != 2)) return {
            code: 403,
            body: {
                code: "FI016",
            }
        };

        if (file.deleted) return {
            code: 409,
            body: {
                code: "FI017",
            }
        };

        // check if file is a purchased doc
        let rows = await mysql.query("SELECT * FROM purchased_docs_file WHERE fileId = ?;", [file.id]);
        let purchasedFile = rows.length ? rows[0] : null;
        // if file has not been verified yet, user cannot delete it
        if (user.role != 2 && purchasedFile && purchasedFile.status == 1) {
            return {
                code: 403,
                body: {
                    code: "FI018",
                }
            };
        }

        // begin transaction
        connection = await mysql.beginTransaction();

        let data = {
            deleted: 1,
            deletedUserMoney: removeMoney,
            deletedComments: comments
        };

        data.deletedReason = 0;
        if (user.role == 2 && copyright) data.deletedReason = 2;
        else if (user.role == 2 && !copyright) data.deletedReason = 5;
        else if (file.userId == userId) {
            if (s3) data.deletedReason = 3;
            else data.deletedReason = 1;
        }

        // file not found in s3
        if (s3) data.s3 = 0;

        await connection.query("UPDATE file SET ?, deletedDate = NOW(), lastUpdate = NOW() WHERE id = ?;", [data, fileId]);

        let uploadFiles = await connection.query("SELECT * FROM file WHERE uploadId = ? AND deleted = 0;", file.uploadId);
        if (!uploadFiles.length) {
            delete data.s3;
            await connection.query("UPDATE upload SET ?, deletedDate = NOW(), lastUpdate = NOW() WHERE id = ?;", [data, file.uploadId]);
            await connection.query(`UPDATE social SET social.deleted = 1 
                WHERE social_upload.uploadId = ? `, file.uploadId);
        }

        if (copyright) {
            await setPopularity(connection, userId, file.userId, 'DELETE_FILE', fileId, -(file.downloads + file.views + 1));
        } else {
            await setPopularity(connection, userId, file.userId, 'DELETE_FILE', fileId, -1);
        }

        if (user.role == 2) {
            if (removeMoney) {
                await connection.query("UPDATE file SET money = 0 WHERE id = ?;", [file.id]);
                await connection.query("UPDATE user SET money = GREATEST(0, money - ?) WHERE userId = ?;", [file.money, file.userId]);
            }

            await deleteReportedFile(event, connection, file, true);
        } else {
            await deleteReportedFile(event, connection, file);
        }

        await connection.query("UPDATE purchased_docs_file SET status = 3 WHERE fileId = ?;", [file.id]);

        // commit all changes and end connection
        await connection.commit();

        return {
            code: 200,
            body: await getFileById(mysql, userId, fileId)
        };
    } catch (err) {
        if (connection) connection.rollback();
        throw err;
    }
};

/**
 * POST /file/<fileId>/print: print-ready file
 */
module.exports.printFile = async function (event) {
    const mysql = event.mysql;

    // query params
    let {
        fileId
    } = event.pathParameters || {};
    fileId = Number(fileId);

    // user
    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    let userId = user.id;

    let connection;
    try {
        let rows = await mysql.query(`SELECT file.*, center.countryId, center.cityId, center.universityId FROM file 
            INNER JOIN center ON center.id = file.centerId
            WHERE file.id = ? AND file.deleted = 0 AND file.s3 = 1;`, fileId);
        if (!rows.length) return {
            code: 404,
            body: {
                code: "FI019"
            }
        };
        let file = rows[0];

        let user = userId ? await getUser(mysql, userId) : null;

        // check user banned
        if (userId && (!user || user.bglobal)) {
            return {
                code: 403,
                body: {
                    code: "FI020"
                }
            };
        }

        let response;

        // begin transaction
        connection = await mysql.beginTransaction();
        if (file.corrupt >= 10) {
            const source = `${process.env.S3_BUCKET_MEDIA}/media/docs/${file.hiddenDirectory}/${file.hiddenFile}`;
            const destBucket = process.env.S3_BUCKET_PUBLIC;
            const destKey = `media/premium/${file.hiddenFile}`;
            response = await copyFile(source, destBucket, destKey, file.fileType);
        } else {
            // check if file already exists
            try {
                let folder = `free/${file.centerId}/${file.studyId}/${file.course}`;
                response = await getFile(process.env.S3_BUCKET_PUBLIC, `media/${folder}/${file.hiddenFile}`);

                // retrieve pixels from dynamodb
                try {
                    let params = {
                        TableName: `${event.db.dynamodb_prefix}pixel`,
                        Key: {
                            "id": `${fileId}${file.centerId}${file.studyId}_${file.course}`
                        }
                    };
                    const data = await db.dynamodb.get(params).promise();
                    response.pixels = data.Item ? data.Item.pixels : [];
                } catch (err) {
                    response.pixels = [];
                }
            } catch (err) {
                if (err.code != 404) {
                    connection.rollback();
                    return {
                        code: 404,
                        body: {
                            code: "FI021"
                        }
                    };
                }

                // check if file exists in S3
                const exists = await checkFile(process.env.S3_BUCKET_MEDIA, `media/docs/${file.hiddenDirectory}/${file.hiddenFile}`);

                if (exists) {
                    // file found in s3

                    // if file is pdf, send it to api-php to generate it
                    if (file.fileType == "application/pdf") {
                        // if file is pdf, generate pdf
                        let url = `${process.env.APIPHPENDPOINT}/v3/pdf/print/${fileId}`;
                        response = await request({
                            url,
                            method: 'POST',
                            json: true
                        });
                    } else {
                        // copy file from original bucket to premium bucket
                        const source = `${process.env.S3_BUCKET_MEDIA}/media/docs/${file.hiddenDirectory}/${file.hiddenFile}`;
                        const destBucket = process.env.S3_BUCKET_PUBLIC;
                        const destKey = `media/premium/${file.hiddenFile}`;
                        response = await copyFile(source, destBucket, destKey, file.fileType);
                    }
                } else {
                    if (file.fileType == "application/pdf") {
                        await deleteS3File(connection, file);
                    }
                    connection.rollback();
                    return {
                        code: 404,
                        body: {
                            code: "FI021"
                        }
                    };
                }
            }
        }

        if (!userId || (user && !user.bdownload && !user.bglobal)) {
            // update file downloads
            await updateDownloads(connection, userId, file, 'PRINT_FILE');

            // pay user
            if (userId && file.fileType == "application/pdf") {
                await payUser(event, connection, userId, file, 'PRINT_FILE');
            }
        }

        // commit all changes and end connection
        await connection.commit();

        return {
            code: 200,
            body: response
        };
    } catch (err) {
        if (connection) connection.rollback();
        if (err.error && err.error.code && err.error.message) {
            return {
                code: err.error.code,
                body: {
                    message: err.error.message,
                }
            };
        } else {
            throw err;
        }
    }
};

/**
 * POST /file/<fileId>/recover: recover file
 */
module.exports.recoverFile = async function (event) {
    const mysql = event.mysql;

    // query params
    let {
        fileId
    } = event.pathParameters || {};
    fileId = Number(fileId);

    // user
    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    if (!user.id) {
        return {
            code: 403,
            body: {
                code: "FI022"
            }
        };
    }

    user = await getUser(mysql, user.id);

    let connection;
    try {
        let rows = await mysql.query(`SELECT * FROM file WHERE file.id = ?;`, fileId);
        if (!rows.length) return {
            code: 404,
            body: {
                code: "FI023"
            }
        };
        let file = rows[0];

        // check whether file is not deleted
        if (!file.deleted) {
            return {
                code: 400,
                body: {
                    code: "FI025"
                }
            };
        }

        // check file deleted reason
        if (file.deletedReason != 1) {
            return {
                code: 403,
                body: {
                    code: "FI024"
                }
            };
        }

        // check user is the owner and is not banned 
        if (user.bglobal || file.userId != user.userId) {
            return {
                code: 403,
                body: {
                    code: "FI026"
                }
            };
        }

        // begin transaction
        connection = await mysql.beginTransaction();

        await connection.query(`UPDATE file SET deleted = 0, deletedReason = NULL, deletedUserMoney = NULL, 
            deletedComments = NULL, deletedDate = NULL WHERE id = ?`, fileId);

        rows = await connection.query('SELECT * FROM upload WHERE id = ?', file.uploadId);
        if (!rows.length) {
            throw new Error("Error retrieving upload information");
        }
        let upload = rows[0];
        if (upload.deleted) {
            await connection.query(`UPDATE upload SET deleted = 0, deletedReason = NULL, deletedUserMoney = NULL, 
            deletedComments = NULL, deletedDate = NULL WHERE id = ?`, file.uploadId);
        }

        // commit all changes and end connection
        await connection.commit();

        return {
            code: 200,
            body: {
                message: `File #${fileId} has been recovered successfully`
            }
        };
    } catch (err) {
        if (connection) connection.rollback();
        throw err;
    }
};

module.exports.like = async function (event) {
    const mysql = event.mysql;

    //Body
    let data = JSON.parse(event.body || null);
    if (!data) return {
        code: 400,
        body: {
            code: "FI001"
        }
    };
    const value = data.value;
    if (value != 0 && value != 1) {
        return {
            code: 400,
            body: {
                code: "FI027"
            }
        };
    };

    //Path
    const {
        fileId = null
    } = event.pathParameters || {};

    //User
    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    const userId = user.id;
    if (!userId || !fileId) {
        return {
            code: 400,
            body: {
                code: "FI027"
            }
        };
    };

    let connection;
    try {

        // check user who liked is not owner
        let owner = await mysql.query("SELECT file.* FROM file WHERE id = ?", fileId);

        if (owner[0].userId == userId) {
            return {
                code: 403,
                body: {
                    code: "FI028"
                }
            };
        };

        // begin transaction
        connection = await mysql.beginTransaction();

        // create like register
        let valueIncrease = await createFileLike(userId, fileId, value, connection);

        // depending on like/dislike, reorder the values to set
        let increases = [];
        let actionName;
        if (value == 0) {
            // if dislike
            increases = [valueIncrease.opposite, valueIncrease.main]
            actionName = "DISLIKE"
        } else if (value == 1) {
            // if like
            increases = [valueIncrease.main, valueIncrease.opposite]
            actionName = "LIKE"
        }

        // update value increases on file
        await connection.query("UPDATE file SET file.likes = GREATEST(file.likes + ?, 0), file.dislikes = GREATEST(file.dislikes + ?, 0) WHERE file.id = ?", [...increases, fileId]);

        // set popularity (v1)
        // popularity of being liked can be positive or negative, depending on whether the like button was pressed to be added or to be erased. The same happens with dislike
        // calulate the popularity depending on the increase (main/opposite) and whether like/dilike. It ranges between [-2, 2]
        await setPopularity(connection, userId, owner[0].userId, 'FILE_' + actionName, fileId, (valueIncrease.main * Math.pow(-1, 1 + value)) + (valueIncrease.opposite * Math.pow(-1, value)));

        // commit all changes and end connection
        await connection.commit();

        return {
            code: 200,
            body: valueIncrease,
        };
    } catch (err) {
        if (connection) connection.rollback();
        throw err;
    }
};

module.exports.share = async function (event) {
    const mysql = event.mysql;

    //Path
    const {
        fileId = null
    } = event.pathParameters || {};

    //Body
    const data = JSON.parse(event.body || null);
    const via = data.via;
    const recipient = data.recipient;
    if (!via) {
        return {
            code: 400,
            body: {
                code: "FI029"
            }
        };
    }

    //User
    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    const userId = user.id;

    let connection;
    try {
        let user = await getUser(mysql, userId);
        let blocked = await isSharedBlocked(mysql, userId, recipient);
        if (blocked) {
            return {
                code: 403,
                body: {
                    code: "FI030"
                }
            };
        }

        if (via == 'email') {
            var re = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
            if (re.test(String(recipient).toLowerCase())) {
                // check disposable mail
                let mailDomain = recipient.replace(/.*@/, "");
                let veredict = await request({
                    uri: `https://open.kickbox.com/v1/disposable/${mailDomain}`,
                    json: true
                });
                if (veredict.disposable) return {
                    code: 422,
                    body: {
                        code: "FI031"
                    }
                };

                let file = await getFileById(mysql, userId, fileId);
                await sendMail(event, {
                    "recipients": [recipient],
                    "subject": `${user.nickname} cree que te puede interesar este documento 🤔`,
                    "template": "https://s3-eu-west-1.amazonaws.com/wuolah-public/mail/templates/es/share/file.html",
                    "templateData": {
                        "nickname": user.nickname,
                        "fileId": file.id,
                        "fileName": file.name,
                        "folderName": file.folderName
                    },
                    "tag": "share"
                });
            } else {
                return {
                    code: 400,
                    body: {
                        code: "FI032"
                    }
                };
            }

        }

        // begin transaction
        connection = await mysql.beginTransaction();

        await connection.query('UPDATE file SET shares = shares + 1 WHERE id = ?', [fileId]);
        let result = await connection.query(`INSERT INTO file_share (userId, fileId, via, recipient) VALUES (?, ?, ?, ?);`, [userId, fileId, via, recipient]);

        // commit all changes and end connection
        await connection.commit();

        let file = await getFileById(mysql, userId, fileId);

        return {
            code: 200,
            body: {
                file: file,
                shareId: result.insertId,
                userId: userId
            }
        };
    } catch (err) {
        if (connection) connection.rollback();
        throw err;
    }
};


// helper methods
var getFileById = async function (mysql, userId, fileId) {
    let userRole = null;
    if (userId) {
        let user = await getUser(mysql, userId);
        userRole = user.role;
    }

    let sql = `SELECT file.*, 
                IF(!file.anonymous OR file.userId = ${userId} OR ${userRole} = 2, file.userId, NULL) AS userId,
                IF(!file.anonymous OR file.userId = ${userId} OR ${userRole} = 2, user.nickname, NULL) AS userNickname,
                IF(!file.anonymous OR file.userId = ${userId} OR ${userRole} = 2, user.popularity, NULL) AS userPopularity,
                IF(!file.anonymous OR file.userId = ${userId} OR ${userRole} = 2, user.money, NULL) AS userMoney,
                IF(!file.anonymous OR file.userId = ${userId} OR ${userRole} = 2, user.link, NULL) AS userLink,
                IF(file.userId = ${userId} OR ${userRole} = 2, file.money, NULL) AS money,
                IF(${userRole} = 2, file.hiddenDirectory, NULL) AS hiddenDirectory,
                IF(${userRole} = 2, file.hiddenFile, NULL) AS hiddenFile,
                folder.link AS folderLink, folder.name AS folderName, 
                center.name AS centerName, center.nameLink AS centerLink, 
                study.name AS studyName, upload.teacher, upload.category, 
                upload.title AS uploadTitle, upload.titleLink AS uploadLink, 
                seg_university.name AS universityName 
                FROM file 
                INNER JOIN folder ON file.folderId = folder.id 
                INNER JOIN center ON file.centerId = center.id 
                INNER JOIN study ON file.studyId = study.id 
                INNER JOIN user ON file.userId = user.userId 
                LEFT JOIN seg_university ON seg_university.id = center.universityId 
                LEFT JOIN upload ON upload.id = file.uploadId 
                WHERE file.id = ?;`;
    let params = [fileId];

    let rows = await mysql.query(sql, params);
    if (!rows.length) {
        throw {
            code: 404,
            body: {
                code: 'FI033',
            }
        };
    }
    return rows[0];
};

var deleteReportedFile = async function (event, connection, file, notifyOwner = false) {
    // if file was reported, send notification to reporters
    const rows = await connection.query(`SELECT report.*, reporter.mail AS userMail, reported.mail AS ownerMail
        FROM report
        INNER JOIN user reporter ON reporter.userId = report.userId
        INNER JOIN user reported ON reported.userId = report.ownerId
        WHERE report.type = 'file' AND report.reportedId = ? AND report.reasonId IN(11, 12);`, file.id);

    if (rows.length) {
        // send mail to reporters
        const reports = [];
        rows.forEach(report => {
            if (!reports.some(rep => rep.userMail == report.userMail)) reports.push(report);
        });

        for (let report of reports) {
            // send mail to reporter
            await sendMail(event, {
                "sender": process.env.MAILING_RECIPIENTS_INFO,
                "recipients": report.userMail,
                "subject": "☑️ El documento denunciado ha sido eliminado",
                "template": "https://s3-eu-west-1.amazonaws.com/wuolah-public/mail/templates/es/copyright/delete_file_reporter.html",
                "copyrightTemplate": "https://s3-eu-west-1.amazonaws.com/wuolah-public/mail/templates/es/copyright_template.html",
                "templateData": {
                    "reportId": report.id,
                    "fileId": file.id
                },
                "tag": "copyright"
            });
        }

        if (notifyOwner) {
            // send mail to owner
            await
                sendMail(event, {
                    "sender": process.env.MAILING_RECIPIENTS_INFO,
                    "recipients": [rows[0].ownerMail],
                    "subject": "❌ Tu documento denunciado ha sido eliminado",
                    "template": "https://s3-eu-west-1.amazonaws.com/wuolah-public/mail/templates/es/copyright/delete_file_owner.html",
                    "copyrightTemplate": "https://s3-eu-west-1.amazonaws.com/wuolah-public/mail/templates/es/copyright_template.html",
                    "templateData": {
                        "reports": reports.map(report => report.id),
                        "fileId": file.id,
                        "fileName": file.name,
                        "folderName": file.folderName,
                        "uploadDate": file.uploadDate
                    },
                    "tag": "copyright"
                });
        }
    }
};

async function setPopularity(connection, userId, recipientId, type, data, popularity) {
    await connection.query("UPDATE user SET popularity = popularity + ? WHERE userId = ?", [popularity, recipientId]);
    await connection.query("INSERT INTO user_popularity SET userId = ?, recipientId = ?, type = ?, `data` = ?, popularity = ?;", [userId, recipientId, type, data, popularity]);
};

var getUser = async function (mysql, userId) {
    let sql = `SELECT user.*, student_study.centerId, student_study.studyId, student_study.course, 
        user_banned.bdownload, user_banned.bupload, user_banned.bsocial, user_banned.bglobal 
        FROM user
        INNER JOIN student_study ON (student_study.userId = user.userId AND student_study.default = 1)
        LEFT JOIN user_banned ON user_banned.userId = user.userId 
        WHERE user.userId = ?`;
    let rows = await mysql.query(sql, userId);
    if (!rows.length) {
        return {
            code: 500,
            body: {
                message: `User #${userId} not found`
            }
        };
    };
    return rows[0];
};

var updateDownloads = async function (connection, userId, file, mode = 'VIEW_FILE', premium = false) {
    if (mode == 'VIEW_FILE' || mode == 'DOWNLOAD_FILE') {
        let type = mode == 'VIEW_FILE' ? 'VIEW' : premium ? 'DOC_PREM' : 'DOC';
        if (userId) {
            let sql = "INSERT INTO downloadsCalendar (userId, fileId, type) VALUES (?, ?, ?);";
            await connection.query(sql, [userId, file.id, type]);
        } else {
            let sql = "INSERT INTO downloadsCalendar (fileId, type) VALUES (?, ?);";
            await connection.query(sql, [file.id, type]);
        }
        if (premium) {
            await connection.query(`UPDATE user SET 
            captchaCounter = GREATEST(captchaCounter - 1, 0), 
            premiumDownloads = GREATEST(premiumDownloads - 1, 0) 
            WHERE userId = ?;`, userId);
        } else {
            await connection.query("UPDATE user SET captchaCounter = GREATEST(captchaCounter - 1, 0) WHERE userId = ?;", userId);
        }

        let downloadsColumn = "downloads";
        if (premium) downloadsColumn = "premiumDownloads";

        if (mode == 'VIEW_FILE') {
            await connection.query("UPDATE file SET views = views + 1 WHERE id = ?", file.id);
        } else if (mode == 'DOWNLOAD_FILE') {
            await connection.query(`UPDATE file SET ${downloadsColumn} = ${downloadsColumn} + 1 WHERE id = ?`, file.id);
        }

        let sql = `UPDATE downloads SET ${downloadsColumn} = ${downloadsColumn} + 1, lastDate = current_timestamp() WHERE userId = ? AND uploadId = ? AND fileId = ?;`;
        let result = await connection.query(sql, [userId, file.uploadId, file.id]);
        if (!result.affectedRows) {
            await connection.query(`INSERT INTO downloads (userId, uploadId, fileId, ${downloadsColumn}) VALUES (?, ?, ?, 1);`, [userId, file.uploadId, file.id]);
        }
    } else if (mode == 'PRINT_FILE') {
        if (userId) {
            let sql = "INSERT INTO downloadsCalendar (userId, fileId, type) VALUES (?, ?, ?);";
            await connection.query(sql, [userId, file.id, 'DOC_PRINT']);
            sql = "UPDATE downloads SET downloads = downloads + 1, lastDate = current_timestamp() WHERE userId = ? AND uploadId = ? AND fileId = ?;";
            let result = await connection.query(sql, [userId, file.uploadId, file.id]);
            if (!result.affectedRows) {
                await connection.query("INSERT INTO downloads (userId, uploadId, fileId) VALUES (?, ?, ?);", [userId, file.uploadId, file.id]);
            }
        } else {
            let sql = "INSERT INTO downloadsCalendar (fileId, type) VALUES (?, ?);";
            await connection.query(sql, [file.id, 'DOC_PRINT']);
        }
    }
};

var checkFile = async function (bucket, key) {
    try {
        await s3.headObject({
            Bucket: bucket,
            Key: key
        }).promise();
        return true;
    } catch (err) {
        return false;
    }
};

var deleteS3File = async function (connection, file) {
    let data = {
        deleted: 1,
        deletedReason: 3,
        deletedComments: 'File not found in S3. User has to upload it again.'
    };

    await connection.query("UPDATE file SET ?, s3 = 0, deletedDate = NOW(), lastUpdate = NOW() WHERE id = ?;", [data, file.id]);

    let uploadFiles = await connection.query("SELECT * FROM file WHERE uploadId = ? AND deleted = 0;", file.uploadId);
    if (!uploadFiles.length) {
        await connection.query("UPDATE upload SET ?, deletedDate = NOW(), lastUpdate = NOW() WHERE id = ?;", [data, file.uploadId]);
        await connection.query(`UPDATE social SET social.deleted = 1 
            WHERE social.uploadId = ? `, file.uploadId);
    }
};

var copyFile = async function (source, destBucket, destKey, mimeType) {
    await s3.copyObject({
        CopySource: source,
        Bucket: destBucket,
        Key: destKey,
        ContentType: mimeType,
        MetadataDirective: 'REPLACE'
    }).promise();
    return {
        url: `https://${destBucket}.s3.amazonaws.com/${destKey}`
    };
};

var getFile = async function (bucket, key) {
    await s3.headObject({
        Bucket: bucket,
        Key: key
    }).promise();
    return {
        url: `https://${bucket}.s3.amazonaws.com/${key}`
    };
};

var updatePreviews = async function (userId, file, connection) {
    if (userId) {
        let sql = "INSERT INTO downloadsCalendar (userId, fileId, type) VALUES (?, ?, 'PREV');";
        await connection.query(sql, [userId, file.id]);
    } else {
        let sql = "INSERT INTO downloadsCalendar (fileId, type) VALUES (?, 'PREV');";
        await connection.query(sql, file.id);
    }

    await connection.query("UPDATE file SET previews = previews + 1 WHERE id = ?", file.id);
};

var payUser = async function (event, connection, userId, file, mode, premium = false) {
    let payment = require(`./${process.env.LAMBDAVERSION}_payment.json`);

    // check if file is not monetizable
    if (!file.monetizable) {
        return false;
    }

    // check if user is the owner of the file
    if (userId == file.userId) {
        return false;
    }

    // get user downloads, owner information, owner studies and money boost file
    let promises = [
        connection.query("SELECT * FROM downloads WHERE userId = ? AND fileId = ?", [userId, file.id]),
        getUser(connection, file.userId),
        connection.query("SELECT * FROM student_study WHERE userId = ? ", [file.userId]),
        request({
            url: `http://s3-eu-west-1.amazonaws.com/${process.env.S3_BUCKET_PUBLIC}/config/moneyBoost.json`,
            json: true
        })
    ];

    const values = await Promise.all(promises);

    if (values.length < 4) {
        return false;
    }

    let downloads = values[0];
    let owner = values[1];
    let studies = values[2];
    let moneyBoost = values[3];

    // check if user has already downloaded the file
    if (downloads.length && ((!premium && downloads[0].downloads > 1) || (premium && downloads[0].premiumDownloads > 1))) {
        return false;
    }

    // check owner banned
    if (owner.bglobal) {
        return false;
    }

    // check user has studies
    if (!studies.length) {
        return false;
    }

    let country = await connection.query('SELECT * FROM seg_country WHERE id = ?', owner.countryId);
    country = country[0];
    if (!country) {
        return false;
    }

    // get total money of the owner
    let studentMoney = owner.money + owner.accumulated;

    let amount, totalAmount = 0;
    if (premium) {
        amount = totalAmount = 0.05;
    } else {
        amount = 0.01;
        if (file.downloads <= payment.maxFileDownloads2) {
            amount += 0.0025;
            if (file.downloads <= payment.maxFileDownloads1) {
                amount += 0.0025;
            }
        }
        if (file.pages > payment.minFilePages) {
            amount += 0.0025;
        }
        if (studentMoney <= payment.maxUserMoney8) {
            amount += 0.0025;
            if (studentMoney <= payment.maxUserMoney7) {
                amount += 0.0025;
                if (studentMoney <= payment.maxUserMoney6) {
                    amount += 0.0025;
                    if (studentMoney <= payment.maxUserMoney5) {
                        amount += 0.0025;
                        if (studentMoney <= payment.maxUserMoney4) {
                            amount += 0.0025;
                            if (studentMoney <= payment.maxUserMoney3) {
                                amount += 0.0025;
                                if (studentMoney <= payment.maxUserMoney2) {
                                    amount += 0.0025;
                                    if (studentMoney <= payment.maxUserMoney1) {
                                        amount += 0.0025;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // calculate money boost based on student money and promotional money boost
        let today = moment();

        let eligibleMoneyBoosts = moneyBoost.filter(moneyBoost => {
            let initDate = moneyBoost.initDate ? moment(moneyBoost.initDate) : moment(-8640000000000000);
            let endDate = moneyBoost.endDate ? moment(moneyBoost.endDate) : moment(8640000000000000);
            return moneyBoost.enabled &&
                today.isBetween(initDate, endDate) &&
                ((moneyBoost.countryId && moneyBoost.countryId == file.countryId) ||
                    (moneyBoost.cityId && moneyBoost.cityId == file.cityId) ||
                    (moneyBoost.universityId && moneyBoost.universityId == file.universityId) ||
                    (moneyBoost.centerId && moneyBoost.centerId == file.centerId));
        });

        eligibleMoneyBoosts.forEach(moneyBoost => {
            let initDate = moneyBoost.initDate ? moment(moneyBoost.initDate) : moment(-8640000000000000);
            let value = moneyBoost.value;
            if (moneyBoost.period) {
                switch (moneyBoost.period) {
                    case "daily":
                        // multiply boost value per number of days
                        value = value * today.diff(initDate, 'day');
                        break;
                    case "weekly":
                        // multiply boost value per number of weeks
                        value = value * today.diff(initDate, 'week');
                        break;
                    case "monthly":
                        // multiply boost value per number of months
                        value = value * today.diff(initDate, 'month');
                        break;
                    case "yearly":
                        // multiply boost value per number of years
                        value = value * today.diff(initDate, 'year');
                        break;
                }
            }

            // if limit is defined, update the boost.
            if (moneyBoost.limit != null) {
                if (value < 0) value = Math.max(value, moneyBoost.limit);
                else if (value > 0) value = Math.min(value, moneyBoost.limit);
            }

            // calculate boosted amount
            if (moneyBoost.type) {
                switch (moneyBoost.type) {
                    case "add":
                        amount += value;
                        break;
                    case "product":
                        amount *= value <= 0 ? 1 : value;
                        break;
                    case "percentage":
                        amount *= 1 + value;
                        break;
                }
            }
        });

        // total amount to pay (max 0.10 euro)
        totalAmount = Math.min(amount, 0.1);
    }

    // apply country coefficient
    let totalAmountByCountry = totalAmount * country.download_coefficient;

    // translate mode to moneyBalance type
    let type = 'PREV';
    if (mode == 'VIEW_FILE') type = 'VIEW';
    else if (mode == 'DOWNLOAD_FILE') {
        if (premium) type = 'DOC_P';
        else type = 'DOC';
    } else if (mode == 'PRINT_FILE') type = 'PRINT';

    // update student money
    // update money balance (premium downloads are marked as correct entries by default)
    // update file properties: money
    promises = [
        connection.query("UPDATE user SET money = money + ? WHERE userId = ?;", [totalAmountByCountry, file.userId]),
        connection.query(`INSERT INTO moneyBalance 
        (userId, fileId, downloadUserId, uploadId, pvp, earned, fraud, correct, type, ip, checked) 
        VALUES (?,?,?,?,?,?,0,?,?,0,0);`, [file.userId, file.id, userId, file.uploadId, amount, totalAmountByCountry, premium, type]),
        connection.query("UPDATE file SET money = money + ?, paidDownloads = paidDownloads + 1 WHERE id = ?;",
            [totalAmountByCountry, file.id])
    ];

    await Promise.all(promises);

    return true;
};

var sendMail = async function (event, data) {
    if (!data.recipients || !data.recipients.length || !data.subject || !data.template) {
        return {
            code: 400,
            body: {
                message: 'Invalid mail properties'
            }
        };
    }

    data.bcc = "correowuolah@gmail.com";
    data.testMode = process.env.LAMBDAVERSION == 'dev' &&
        data.recipients.some(email => !email.includes("@wuolah.com"));
    const params = {
        Message: JSON.stringify(data),
        TopicArn: process.env.TOPIC_MAILING
    };
    const response = await sns.publish(params).promise();
    return response;
};

var createFileLike = async function (userId, fileId, value, connection) {
    let actualLike = await getUserLike(userId, fileId, connection);
    let sql;
    let params;
    let valueIncrease = {
        main: 0,
        opposite: 0
    };

    // if a like already exists, 
    if (actualLike.isVoted) {
        // delete the entry if it was the same value OR
        if (actualLike.vote == value) {
            sql = "DELETE FROM file_like WHERE file_like.fileId = ? AND file_like.userId = ? ";
            params = [fileId, userId];
            valueIncrease.main--;
            //update it if the opposite value has been sent  
        } else {
            sql = "UPDATE file_like SET file_like.vote = ?, file_like.created = NOW() WHERE fileId = ? AND userId = ?";
            params = [value, fileId, userId];
            valueIncrease.main++;
            valueIncrease.opposite--;
        }
    } else {
        // if no like exists, insert a new entry
        sql = "INSERT INTO file_like (fileId, userId, vote) VALUES (?, ?, ?);";
        params = [fileId, userId, value];
        valueIncrease.main++;
    }

    await connection.query(sql, params);

    // this method returns the difference on the number of likes/dislikes; whether the changes are from one or the other is handled on the method that calls this one
    return valueIncrease;
};

async function getUserLike(userId, fileId, connection) {
    let sql = `SELECT file_like.* FROM file_like WHERE file_like.userId = ? AND file_like.fileId = ?`;

    let params = [userId, fileId];

    const rows = await connection.query(sql, params);
    if (!rows.length) {
        return {
            isVoted: false
        };
    } else {
        return {
            isVoted: true,
            ...rows[0]
        }
    }
};

var isSharedBlocked = async function (connection, userId, to) {
    let sql = "SELECT * from file_share_blocked WHERE userId = ? && (blocked = ? OR blockAll = 1)";
    let params = [userId, to];

    let blocked = await connection.query(sql, params);
    return blocked.length > 0;
};