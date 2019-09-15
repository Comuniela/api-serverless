module.exports.searchGiveaways = async function (event) {
    const mysql = event.mysql;

    let {
        userId,
        status = 1
    } = event.queryStringParameters || {};
    const includeTickets = event.queryStringParameters ? JSON.parse(event.queryStringParameters.includeTickets || null) : null;
    const includeWinner = event.queryStringParameters ? JSON.parse(event.queryStringParameters.includeWinner || null) : null;
    const joined = event.queryStringParameters ? JSON.parse(event.queryStringParameters.joined || null) : null;

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };
    if (!userId) userId = user.id;

    if ((includeTickets || joined) && !userId) {
        return {
            code: 400,
            body: {
                code: "GI001"
            }
        }
    }

    let columns = [
        "giveaway.id",
        "IF(giveaway.startTime <= NOW() AND giveaway.endTime > NOW(), 1, IF(giveaway.startTime>NOW(), 2, 0)) AS status",
        "giveaway.endTime", "giveaway.startTime", "winner",
        "IFNULL((SELECT COUNT(id) AS participants FROM giveaway_ticket gt WHERE giveaway.id = gt.giveawayId GROUP BY gt.giveawayId), 0) AS participants"
    ];
    let table = "giveaway";
    let joins = [
        "INNER JOIN giveaway_region ON giveaway_region.giveawayId = giveaway.id"
    ];
    let conditions = ["giveaway.deleted != 1"];
    let params = [];

    if (joined) {
        joins.push("INNER JOIN giveaway_ticket ON giveaway_ticket.giveawayId = giveaway.id");
        conditions.push("giveaway_ticket.userId = ?");
        params.push(userId);
    } else if (userId) {
        joins.push(
            "INNER JOIN student_study ON student_study.userId = ?",
            "INNER JOIN center ON center.id = student_study.centerId"
        );
        params.push(userId);
        conditions.push("(giveaway_region.countryId = 0 OR \
            (giveaway_region.countryId = center.countryId AND giveaway_region.cityId = 0) OR \
            (giveaway_region.countryId = center.countryId AND giveaway_region.cityId = center.cityId))");
    }

    if (includeWinner) {
        columns.push(
            "giveaway_ticket_winner.number AS winner_number",
            "giveaway_ticket_winner.userId AS winner_userId",
            "giveaway_ticket_winner.fileId AS winner_fileId",
            "giveaway_ticket_winner.invitedUserId AS winner_invitedUserId"
        );
        joins.push("LEFT JOIN giveaway_ticket giveaway_ticket_winner ON giveaway_ticket_winner.id = giveaway.winner");
    }

    if (status == 0) {
        conditions.push("NOW() > endTime");
    } else {
        conditions.push("startTime <= NOW()", "endTime > NOW()");
    }

    // create connection to slave database
    let connection = mysql.connect(false);

    try {
        let sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")} GROUP BY giveaway.id ORDER BY giveaway.endTime DESC, id DESC`;
        let rows = await connection.query(sql, params);

        let promises = rows.map(row => {
            let giveaway = row;
            let promise = [giveaway];

            if (includeTickets) {
                // get user tickets
                let sql_tickets = `SELECT file.deleted as fileDeleted, giveaway_ticket.id, giveaway_ticket.number, 
                    giveaway_ticket.giveawayId, giveaway_ticket.fileId, 
                    file.name AS fileName, file.extension AS fileExtension, 
                    invitedUserId AS inviteeUserId, 
                    user.nickname AS inviteeNickname, 
                    user.link AS inviteeLink, 
                    seg_university.name AS inviteeUniversityName, 
                    (case
                        when giveaway_ticket.fileId IS NOT NULL then 'file'
                        when giveaway_ticket.invitedUserId IS NOT NULL then 'invitation'
                        else 'promo'
                    end) AS type 
                    FROM giveaway_ticket 
                    LEFT JOIN file ON file.id = giveaway_ticket.fileId 
                    LEFT JOIN student_study ON student_study.userId = giveaway_ticket.invitedUserId AND student_study.default = 1 
                    LEFT JOIN user ON giveaway_ticket.invitedUserId = user.userId 
                    LEFT JOIN center ON center.id = student_study.centerId 
                    LEFT JOIN seg_university ON seg_university.id = center.universityId 
                    WHERE giveaway_ticket.giveawayId = ? AND giveaway_ticket.userId = ?;`;
                promise.push(connection.query(sql_tickets, [giveaway.id, userId]));
            }

            if (giveaway.winner_number != null && includeWinner) {
                // get giveaway winner details
                let sql_winner = `SELECT user.nickname, user.popularity, 
                    seg_university.name AS universityName 
                    FROM user 
                    INNER JOIN student_study ON student_study.userId = user.userId AND student_study.default = 1
                    INNER JOIN center ON center.id = student_study.centerId
                    INNER JOIN seg_university ON seg_university.id = center.universityId
                    WHERE user.userId = ?;`;
                promise.push(connection.query(sql_winner, [giveaway.winner_userId]));

                if (giveaway.winner_fileId != null) {
                    promise.push(connection.query("SELECT id, name, extension FROM file WHERE id = ?", [giveaway.winner_fileId]));
                } else if (giveaway.winner_invitedUserId != null) {
                    promise.push(connection.query("SELECT user.userId, user.nickname \
                        FROM user WHERE userId = ?", [giveaway.winner_invitedUserId]));
                }
            }

            return Promise.all(promise);
        });

        let data = await Promise.all(promises);

        // add winner ticket details
        let result = data.map(giveawayData => {
            let giveaway = giveawayData.shift();

            // include user tickets
            if (includeTickets) {
                let tickets = giveawayData.shift();
                giveaway.tickets = buildTickets(tickets);
            }

            // include winner details
            if (includeWinner && giveaway.winner_number != null) {
                let winner_rows = giveawayData.shift();
                if (winner_rows.length) {
                    let extraData = giveawayData.shift(); // file or invited user details
                    giveaway.winner = buildWinner(winner_rows[0], {
                        userId: giveaway.winner_userId,
                        number: giveaway.winner_number,
                        fileId: giveaway.winner_fileId,
                        invitedUserId: giveaway.winner_invitedUserId,
                        extraData
                    });
                }
            }

            delete giveaway.winner_userId;
            delete giveaway.winner_invitedUserId;
            delete giveaway.winner_fileId;
            delete giveaway.winner_number;

            return giveaway;
        });

        // end connection
        await connection.end();

        return {
            code: 200,
            body: result
        };

    } catch (err) {
        if (connection) connection.end();
        throw err;
    }
}

module.exports.getGiveawayById = async function (event) {
    const mysql = event.mysql;

    const {
        giveawayId
    } = event.pathParameters || {};

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    let columns = [
        "giveaway.id", "giveaway.winner", "giveaway.startTime", "giveaway.endTime",
        "giveaway_ticket.number AS winner_number", "giveaway_ticket.userId AS winner_userId",
        "giveaway_ticket.fileId AS winner_fileId", "giveaway_ticket.invitedUserId AS winner_invitedUserId",
        "IF(giveaway.startTime <= NOW() AND giveaway.endTime > NOW(), 1, IF(giveaway.startTime>NOW(), 2, 0)) AS status",
        "IFNULL((SELECT COUNT(id) AS participants FROM giveaway_ticket gt WHERE giveaway.id = gt.giveawayId GROUP BY gt.giveawayId), 0) AS participants"
    ];
    let table = "giveaway";
    let joins = ["LEFT JOIN giveaway_ticket ON giveaway_ticket.id = giveaway.winner"];
    let conditions = ["giveaway.id = ?", "giveaway.deleted != 1"];
    let params = [giveawayId];

    // create connection to slave database
    let connection = mysql.connect(false);

    try {
        let sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;
        let rows = await connection.query(sql, params);
        if (!rows.length) {
            await connection.end();
            return {
                code: 404,
                body: {
                    code: "GI002"
                }
            }
        }

        let giveaway = rows[0];

        let promises = [];

        // Sacamos la segmentacion
        let sql_segmentation = `SELECT seg_city.id AS cityId, 
            IF(seg_city.name IS NULL or seg_city.name = '', 'Todas', seg_city.name) AS cityName, 
            seg_country.id AS countryId, 
            IFNULL(seg_country.name, 'Todos') AS countryName 
            FROM giveaway_region 
            LEFT JOIN seg_city ON seg_city.id = giveaway_region.cityId 
            LEFT JOIN seg_country ON seg_country.id = giveaway_region.countryId 
            WHERE giveawayId = ?;`;
        promises.push(connection.query(sql_segmentation, [giveaway.id]));

        if (user.id) {
            // get user tickets
            let sql_tickets = `SELECT giveaway_ticket.id, giveaway_ticket.number, 
                giveaway_ticket.giveawayId, giveaway_ticket.fileId, 
                file.name AS fileName, file.extension AS fileExtension, 
                invitedUserId AS inviteeUserId, 
                user.nickname AS inviteeNickname, 
                user.link AS inviteeLink, 
                seg_university.name AS inviteeUniversityName, 
                (case
                    when giveaway_ticket.fileId IS NOT NULL then 'file'
                    when giveaway_ticket.invitedUserId IS NOT NULL then 'invitation'
                    else 'promo'
                end) AS type 
                FROM giveaway_ticket 
                LEFT JOIN file ON file.id = giveaway_ticket.fileId 
                LEFT JOIN student_study ON student_study.userId = giveaway_ticket.invitedUserId AND student_study.default = 1 
                LEFT JOIN user ON giveaway_ticket.invitedUserId = user.userId 
                LEFT JOIN center ON center.id = student_study.centerId 
                LEFT JOIN seg_university ON seg_university.id = center.universityId 
                WHERE giveaway_ticket.giveawayId = ? AND giveaway_ticket.userId = ? AND 
                giveaway_ticket.deleted != 1 AND (file.deleted != 1 OR file.deleted IS NULL);`;
            promises.push(connection.query(sql_tickets, [giveaway.id, user.id]));
        }

        if (giveaway.winner_number != null) {
            // get giveaway winner details
            let sql_winner = `SELECT user.nickname, user.popularity, 
                seg_university.name AS universityName 
                FROM user 
                INNER JOIN student_study ON student_study.userId = user.userId AND student_study.default = 1
                INNER JOIN center ON center.id = student_study.centerId
                INNER JOIN seg_university ON seg_university.id = center.universityId
                WHERE user.userId = ?;`;
            promises.push(connection.query(sql_winner, [giveaway.winner_userId]));

            if (giveaway.winner_fileId != null) {
                promises.push(connection.query("SELECT id, name, extension FROM file WHERE id = ?", [giveaway.winner_fileId]));
            } else if (giveaway.winner_invitedUserId != null) {
                promises.push(connection.query("SELECT user.userId, user.nickname \
                    FROM user WHERE userId = ?", [giveaway.winner_invitedUserId]));
            }
        }

        // get giveaway information (segmentation and user)
        let giveawayData = await Promise.all(promises);

        giveaway.segmentation = giveawayData.shift();
        if (user.id) {
            let tickets = giveawayData.shift();
            giveaway.tickets = buildTickets(tickets);
        }

        // include winner details
        if (giveaway.winner_number != null) {
            let winner_rows = giveawayData.shift();
            if (winner_rows.length) {
                let extraData = giveawayData.shift(); // file or invited user details
                giveaway.winner = buildWinner(winner_rows[0], {
                    userId: giveaway.winner_userId,
                    number: giveaway.winner_number,
                    fileId: giveaway.winner_fileId,
                    invitedUserId: giveaway.winner_invitedUserId,
                    extraData
                });
            }
        }

        delete giveaway.winner_userId;
        delete giveaway.winner_invitedUserId;
        delete giveaway.winner_fileId;
        delete giveaway.winner_number;

        // end connection
        await connection.end();

        return {
            code: 200,
            body: giveaway
        };
    } catch (err) {
        if (connection) connection.end();
        throw err;
    }
}

module.exports.getMyTickets = async function (event) {
    const mysql = event.mysql;

    const onlyCount = event.queryStringParameters ? JSON.parse(event.queryStringParameters.onlyCount || null) : null;
    const active = event.queryStringParameters ? JSON.parse(event.queryStringParameters.active || null) : null;

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    if (!user.id) {
        return {
            code: 401,
            body: {
                code: "GI003"
            }
        }
    }

    let columns = [];
    let table = "giveaway_ticket";
    let joins = ["LEFT JOIN file ON file.id = giveaway_ticket.fileId"];
    let conditions = [
        "giveaway_ticket.userId = ?",
        "(file.deleted != 1 OR file.deleted IS NULL)",
        "giveaway_ticket.deleted != 1"
    ];
    let params = [user.id];

    if (onlyCount) {
        columns = ["COUNT(giveaway_ticket.id) AS total"];
    } else {
        columns = [
            "giveaway_ticket.id", "giveaway_ticket.number",
            "giveaway_ticket.giveawayId", "giveaway_ticket.fileId",
            "file.name AS fileName", "file.extension AS fileExtension",
            "invitedUserId AS inviteeUserId",
            "user.nickname AS inviteeNickname",
            "user.link AS inviteeLink",
            "seg_university.name AS inviteeUniversityName",
            `(case
                when giveaway_ticket.fileId IS NOT NULL then 'file'
                when giveaway_ticket.invitedUserId IS NOT NULL then 'invitation'
                else 'promo'
            end) AS type`
        ];
        joins.push(
            "LEFT JOIN student_study ON student_study.userId = giveaway_ticket.invitedUserId AND student_study.default = 1",
            "LEFT JOIN user ON giveaway_ticket.invitedUserId = user.userId",
            "LEFT JOIN center ON center.id = student_study.centerId",
            "LEFT JOIN seg_university ON seg_university.id = center.universityId"
        );
    }

    if (active) {
        conditions.push(
            "YEARWEEK(giveaway_ticket.created, 1) = YEARWEEK(NOW(), 1)",
            "giveaway_ticket.giveawayId IS NULL",
        );
    }

    let sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;
    let rows = await mysql.query(sql, params);

    let response;
    if (onlyCount) response = { tickets: rows[0].total };
    else response = buildTickets(rows);

    return {
        code: 200,
        body: response
    };
}

module.exports.getGiveawayTickets = async function (event) {
    const mysql = event.mysql;

    const {
        giveawayId
    } = event.pathParameters || {};

    const {
        limit = 50,
        offset = 0
    } = event.queryStringParameters || {};

    let columns = ["giveaway_ticket.id", "giveaway_ticket.number",
        "giveaway_ticket.giveawayId", "giveaway_ticket.fileId",
        "file.name AS fileName", "file.extension AS fileExtension",
        "giveaway_ticket.userId",
        "user.nickname AS userNickname",
        "user.popularity AS userPopularity",
        "user.link AS userLink",
        "seg_university.name AS userUniversityName",

        "invitedUserId AS inviteeUserId",
        "inviteeProfile.nickname AS inviteeNickname",
        "inviteeProfile.popularity AS inviteePopularity",
        "inviteeProfile.link AS inviteeLink",
        "inviteeUniversity.name AS inviteeUniversityName",
        `(case
            when giveaway_ticket.fileId IS NOT NULL then 'file'
            when giveaway_ticket.invitedUserId IS NOT NULL then 'invitation'
            else 'promo'
        end) AS type`
    ];
    let table = "giveaway_ticket";
    let joins = [
        "INNER JOIN user ON user.userId = giveaway_ticket.userId",
        "INNER JOIN student_study ON student_study.userId = user.userId AND student_study.default = 1",
        "INNER JOIN center ON center.id = student_study.centerId",
        "INNER JOIN seg_university ON seg_university.id = center.universityId",

        "LEFT JOIN file ON file.id = giveaway_ticket.fileId",

        "LEFT JOIN user AS inviteeProfile ON inviteeProfile.userId = giveaway_ticket.invitedUserId",
        "LEFT JOIN student_study AS inviteeStudy ON inviteeStudy.userId = inviteeProfile.userId AND inviteeStudy.default = 1",
        "LEFT JOIN center AS inviteeCenter ON inviteeCenter.id = inviteeStudy.centerId",
        "LEFT JOIN seg_university AS inviteeUniversity ON inviteeUniversity.id = inviteeCenter.universityId"
    ];
    let conditions = [
        "giveaway_ticket.giveawayId = ?",
        "(file.deleted != 1 OR file.deleted IS NULL)",
        "giveaway_ticket.deleted != 1"
    ];

    let sqlTickets = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")} LIMIT ? OFFSET ?`;

    columns = ["COUNT(*) AS total"];
    joins = ["LEFT JOIN file ON file.id = giveaway_ticket.fileId"];
    let sqlCount = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;

    let promises = [
        mysql.query(sqlCount, [giveawayId]),
        mysql.query(sqlTickets, [giveawayId, Number(limit), Number(offset)])
    ];

    let values = await Promise.all(promises);
    let total = values[0][0].total;
    let tickets = buildTickets(values[1], true);

    return {
        code: 200,
        body: {
            total,
            tickets
        }
    };
}

module.exports.redeemTickets = async function (event) {
    const mysql = event.mysql;

    const {
        giveawayId
    } = event.pathParameters || {};

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    if (!user.id) {
        return {
            code: 401,
            body: {
                code: "GI003"
            }
        }
    }

    let body = JSON.parse(event.body || null);
    let quantity = body && body.quantity ? body.quantity : 1;

    let promises = [];

    // check whether giveaway is active or not
    let sql = "SELECT id, startTime, endTime, countryId, cityId \
        FROM giveaway \
        INNER JOIN giveaway_region ON giveaway_region.giveawayId = giveaway.id \
        WHERE giveaway.id = ? AND giveaway.deleted != 1 AND \
        giveaway.startTime < NOW() AND giveaway.endTime >= NOW();";
    let rows = await mysql.query(sql, giveawayId);
    if (!rows.length) {
        return {
            code: 404,
            body: {
                code: "GI004"
            }
        }
    }
    let giveaway = rows[0];

    // get available tickets (unused and no deleted)
    sql = "SELECT giveaway_ticket.id \
        FROM giveaway_ticket \
        LEFT JOIN file ON file.id = giveaway_ticket.fileId \
        WHERE giveaway_ticket.userId = ? AND giveaway_ticket.deleted != 1 AND giveaway_ticket.giveawayId IS NULL AND giveaway_ticket.created >= ? AND giveaway_ticket.created < ? AND \
        ((giveaway_ticket.invitedUserId is not NULL) OR \
        (giveaway_ticket.fileId is not NULL AND (file.deleted != 1 OR file.deleted IS NULL)) OR \
        (giveaway_ticket.fileId is NULL AND giveaway_ticket.invitedUserId is NULL)) \
        LIMIT ?;";
    promises.push(mysql.query(sql, [user.id, giveaway.startTime, giveaway.endTime, quantity]));

    // get user info to check elegibility for this giveaway
    sql = "SELECT cityId, countryId \
        FROM student_study \
        INNER JOIN center ON center.id = student_study.centerId \
        WHERE student_study.userId = ? AND student_study.default = 1;"
    promises.push(mysql.query(sql, [user.id]));

    let values = await Promise.all(promises);
    let tickets = values[0];
    let userSegmentations = values[1];

    if (!tickets.length || quantity > tickets.length) {
        return {
            code: 403,
            body: {
                code: 'GI005'
            }
        }
    }

    if (!userSegmentations.length) {
        return {
            code: 403,
            body: {
                code: 'GI006'
            }
        }
    }
    let segmentation = userSegmentations[0];

    var elegibility = false;
    for(let i = 0; i < rows.length; i++){
        elegibility = (elegibility || !rows[i].countryId ||(rows[i].countryId == segmentation.countryId && !rows[i].cityId) 
                        || (rows[i].countryId == segmentation.countryId && rows[i].cityId == segmentation.cityId));
    }

    if (!elegibility) {
        return {
            code: 403,
            body: {
                code: "GI007"
            }
        }
    }

    sql = "UPDATE giveaway_ticket \
        SET giveaway_ticket.giveawayId = ?, giveaway_ticket.used = NOW(), giveaway_ticket.number = \
        (SELECT * FROM (SELECT COALESCE(MAX(number) + 1, 0) FROM giveaway_ticket gt WHERE gt.giveawayId = ?) subquery) \
        WHERE giveaway_ticket.id = ? AND created >= ? AND created < ?;";
    promises = tickets.map(t => mysql.query(sql, [giveawayId, giveawayId, t.id, giveaway.startTime, giveaway.endTime]));
    await Promise.all(promises);

    return {
        code: 200,
        body: {
            message: `${tickets.length} ${tickets.length > 1 ?
                'tickets redeemed successfully' : 'ticket redeemed successfully'}`
        }
    };
}

module.exports.redeemTicket = async function (event) {
    const mysql = event.mysql;

    const {
        giveawayId,
        ticketId
    } = event.pathParameters || {};

    let user = event.requestContext.authorizer && event.requestContext.authorizer.id ? event.requestContext.authorizer : {
        id: null,
        role: null
    };

    if (!user.id) {
        return {
            code: 401,
            body: {
                code: "GI003"
            }
        }
    }

    let promises = [];

    // check whether giveaway is active or not
    let sql = "SELECT id, startTime, endTime, countryId, cityId \
        FROM giveaway \
        INNER JOIN giveaway_region ON giveaway_region.giveawayId = giveaway.id \
        WHERE giveaway.id = ? AND giveaway.deleted != 1 AND \
        giveaway.startTime < NOW() AND giveaway.endTime >= NOW();";
    let rows = await mysql.query(sql, giveawayId);
    if (!rows.length) {
        return {
            code: 404,
            body: {
                code: "GI004"
            }
        }
    }
    let giveaway = rows[0];

    // check ticket (unused and no deleted)
    sql = "SELECT giveaway_ticket.id \
        FROM giveaway_ticket \
        WHERE giveaway_ticket.id = ? AND giveaway_ticket.userId = ? AND giveaway_ticket.deleted != 1 AND giveawayId IS NULL AND created >= ? AND created < ? \
        LIMIT ?;";
    promises.push(mysql.query(sql, [ticketId, user.id, giveaway.startTime, giveaway.endTime, quantity]));

    // get user info to check elegibility for this giveaway
    sql = "SELECT cityId, countryId \
        FROM student_study \
        INNER JOIN center ON center.id = student_study.centerId \
        WHERE student_study.userId = ? AND student_study.default = 1;"
    promises.push(mysql.query(sql, [user.id]));

    let values = await Promise.all(promises);
    let tickets = values[0];
    let userSegmentations = values[1];

    if (!tickets.length) {
        return {
            code: 403,
            body: {
                code: "GI005"
            }
        }
    }
    let ticket = tickets[0];

    if (!userSegmentations.length) {
        return {
            code: 403,
            body: {
                code: "GI006"
            }
        }
    }
    let segmentation = userSegmentations[0];
    let elegibility = !giveaway.countryId ||
        (giveaway.countryId == segmentation.countryId && !giveaway.cityId) ||
        (giveaway.countryId == segmentation.countryId && giveaway.cityId == segmentation.cityId);

    if (!elegibility) {
        return {
            code: 403,
            body: {
                code: "GI007"
            }
        }
    }

    sql = "UPDATE giveaway_ticket \
        SET giveaway_ticket.giveawayId = ?, giveaway_ticket.used = NOW(), giveaway_ticket.number = \
        (SELECT * FROM (SELECT MAX(number) + 1 FROM giveaway_ticket gt WHERE gt.giveawayId = ?) subquery) \
        WHERE giveaway_ticket.id = ? AND created >= ? AND created < ?;";
    await mysql.query(sql, [giveawayId, giveawayId, ticket.id, giveaway.startTime, giveaway.endTime]);

    return {
        code: 200,
        body: {
            message: "Ticket redeemed successfully"
        }
    };
}

function buildTickets(tickets, includeUserDetails = false) {
    return tickets.map(t => {
        let ticket = { id: t.id, number: t.number, giveawayId: t.giveawayId };
        if (includeUserDetails) {
            ticket.userId = t.userId;
            ticket.userPopularity = t.userPopularity;
            ticket.userLink = t.userLink;
            ticket.userNickname = t.userNickname;
            ticket.userUniversityName = t.userUniversityName;
        }
        if (t.fileId) {
            ticket.type = "file";
            ticket.file = {
                id: t.fileId,
                name: t.fileName,
                extension: t.fileExtension,
                deleted: t.fileDeleted
            };
        } else if (t.inviteeUserId) {
            ticket.type = "invitation";
            ticket.invitee = {
                userId: t.inviteeUserId,
                nickname: t.inviteeNickname,
                link: t.inviteeLink,
                universityName: t.inviteeUniversityName,
            };
        } else {
            ticket.type = "promo";
            ticket.promo = {
                title: 'Promoción ticket gratuito semanal'
            };
        }
        return ticket;
    });
}

function buildWinner(winner, data) {
    let {
        userId,
        number,
        fileId,
        invitedUserId,
        extraData
    } = data;
    winner.userId = userId;
    winner.number = number;
    if (fileId != null) {
        let file_rows = extraData;
        winner.type = 'file';
        winner.file = file_rows.length ? file_rows[0] : {};
    } else if (invitedUserId != null) {
        let invited_rows = extraData;
        winner.type = 'invitation';
        winner.invitee = invited_rows.length ? invited_rows[0] : {};
    } else {
        winner.type = 'promo';
        winner.promo = {
            title: 'Promoción ticket gratuito semanal'
        };
    }
    return winner;
}