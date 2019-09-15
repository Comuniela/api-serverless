const AWS = require("aws-sdk")
const documentClient = new AWS.DynamoDB.DocumentClient({
    "region": "eu-west-1"
});

module.exports.searchCenters = async function (event) {
    const mysql = event.mysql;
    // get query string properties
    const {
        id,
        name,
        countryId,
        cityId,
        regionId,
        universityId,
        verified,
        sort,
        studyType,
        limit = 10,
        offset = 0
    } = event.queryStringParameters || {};
    const deleted = event.queryStringParameters ? JSON.parse(event.queryStringParameters.deleted || null) : null;

    let columns = ["center.id", "center.name", "center.shortName", "center.nameLink", "center.countryId",
        "center.cityId", "center.universityId", "center.courseType", "center.zip", "center.zone", "center.latitude", "center.longitude",
        "center.verified", "center.deleted", "center.regionId", "seg_country.name AS countryName", "seg_city.name AS cityName",
        "seg_university.name AS universityName", "seg_country.verified AS countryVerified", "seg_city.verified AS cityVerified",
        "seg_university.verified AS universityVerified",
        "(SELECT COUNT(student_study.id) FROM student_study WHERE student_study.centerId = center.id AND removed = 0) AS users"
    ];
    let table = "center";
    let joins = [
        "INNER JOIN seg_country ON seg_country.id = center.countryId",
        "LEFT JOIN seg_city ON seg_city.id = center.cityId",
        "LEFT JOIN seg_university ON seg_university.id = center.universityId"
    ];
    let conditions = ["center.id <> 0"];
    let params = [];
    let orderBy = [];

    if (id != null) {
        conditions.push("center.id = ?");
        params.push(id);
    }
    if (name != null) {
        // let terms = name.split(" ").filter(t => t && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(t));
        // conditions.push("MATCH (center.name, center.shortName) AGAINST (? IN BOOLEAN MODE)");
        // params.push(terms.map(term => `+*${term}*`).join(" "));

        let terms = name.split(" ").filter(t => t && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(t));
        conditions.push(terms.map(term => `center.name LIKE ?`).join(" AND "));
        params = params.concat(terms.map(term => `%${term}%`));
    }
    if (countryId != null) {
        conditions.push("center.countryId = ?");
        params.push(countryId);
    }
    if (cityId != null) {
        conditions.push("center.cityId = ?");
        params.push(cityId);
    }
    if (regionId != null) {
        conditions.push("center.regionId = ?");
        params.push(regionId);
    }
    if (universityId != null) {
        conditions.push("center.universityId = ?");
        params.push(universityId);
    }
    if (verified != null) {
        conditions.push("center.verified = ?");
        params.push(verified);
    }
    if (deleted != null) {
        conditions.push("center.deleted = ?");
        params.push(deleted);
    }
    if (studyType != null) {
        joins.push("INNER JOIN rel_center_study ON rel_center_study.centerId = center.id");
        conditions.push("rel_center_study.type = ?");
        params.push(studyType);
    }

    if (sort != null) {
        if (sort == "users") {
            orderBy.push("users ASC");
        } else if (sort == "-users") {
            orderBy.push("users DESC");
        }
    }
    orderBy.push("center.name ASC");

    let sql = `SELECT ${columns} FROM ${table} ${joins.join(" ")} WHERE ${conditions.join(" AND ")} GROUP BY center.id ORDER BY ${orderBy.join(",")} LIMIT ? OFFSET ?`;
    params.push(Number(limit), Number(offset));

    const rows = await mysql.query(sql, params);
    return {
        code: 200,
        body: rows
    };
}

module.exports.getCenterById = async function (event) {
    const mysql = event.mysql;
    // get query string properties
    const {
        centerId
    } = event.pathParameters || {};
    if (centerId == 0) {
        return {
            code: 404,
            body: {
                code: "CE001"
            }
        };
    }

    let columns = ["center.id", "center.name", "center.shortName", "center.nameLink", "center.countryId",
        "center.cityId", "center.universityId", "center.courseType", "center.zip", "center.zone", "center.latitude", "center.longitude",
        "center.verified", "center.deleted", "center.regionId", "seg_country.name AS countryName", "seg_city.name AS cityName",
        "seg_university.name AS universityName", "seg_country.verified AS countryVerified", "seg_city.verified AS cityVerified",
        "seg_university.verified AS universityVerified",
        "(SELECT COUNT(student_study.id) FROM student_study WHERE student_study.centerId = center.id AND removed = 0) AS users"
    ];
    let tables = ["center"];
    let joins = [
        "INNER JOIN seg_country ON seg_country.id = center.countryId",
        "INNER JOIN seg_city ON seg_city.id = center.cityId",
        "INNER JOIN seg_university ON seg_university.id = center.universityId"
    ];
    let conditions = ["center.id = ?", "center.deleted = 0", "center.id <> 0"];
    let params = [centerId];

    let sql = `SELECT ${columns} FROM ${tables} ${joins.join(" ")} WHERE ${conditions.join(" AND ")}`;

    const rows = await mysql.query(sql, params);
    if (!rows.length) {
        return {
            code: 404,
            body: {
                code: "CE002"
            }
        };
    }
    return {
        code: 200,
        body: rows[0]
    };
}

module.exports.getCenterByIdRewards = async function (event) {

    let centerId
    if (event.pathParameters.centerId)
        centerId = event.pathParameters.centerId;

    let date = (event.queryStringParameters && event.queryStringParameters.date) ? event.queryStringParameters.date : new Date().getTime();

    var params = {
        TableName: `${process.env.DYNAMODB_PREFIX}invitationRewards`,
        KeyConditionExpression: 'centerId = :c and created < :d',
        ExpressionAttributeValues: {
            ':c': parseInt(centerId),
            ':d': parseInt(date)
        },
        ScanIndexForward: false,
        Limit: 1
    };

    let data = await documentClient.query(params).promise();

    if (data.Items.length)
        return {
            code: 200,
            body: data.Items[0]
        };
    else
        return {
            code: 200,
            body: {}
        };
}