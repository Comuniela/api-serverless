const mysql = require('mysql');
const util = require('util');
const tunnel = require('tunnel-ssh');
const fs = require('fs');

/**
 * Configure MySQL connections.  
 * If configuration parameters are not passed in, it will fallback to environment variables.  
 * Connection properties are `host`, `user`, `password` and `database`.
 * @param {object} config Object containing connection properties.
 */
module.exports.configure = async function (config = {}) {
    if (global.dbset) return;
    const cfg = {
        host: process.env.IS_OFFLINE ? 'localhost' : config.host || process.env.DB_HOST,
        user: config.user || process.env.DB_USER,
        password: config.password || process.env.DB_PASSWORD,
        database: config.database || process.env.DB_NAME,
        dateStrings: config.dateStrings != undefined ? config.dateStrings : true,
        multipleStatements: config.multipleStatements != undefined ? config.multipleStatements : false
    };
    global.config = cfg;

    if (process.env.IS_OFFLINE) {
        await createTunnel({
            username: 'ec2-user',
            host: '52.18.152.222',
            port: 22,
            privateKey: fs.readFileSync('./wuolah-admin.pem'),
            dstHost: config.host,
            dstPort: 3306,
            keepAlive: true
        }).catch(error => {
            console.log(error);
        });
    }

    global.dbset = true;
}

/**
 * Creates a connection to the database.
 * @returns {object} connection object.
 */
var connect = function () {
    // get connection properties
    const config = global.config;
    if (!global.dbset || !config) {
        throw new Error('Not configured. Call configure() first.');
    }

    // create connection
    const _connection = mysql.createConnection(config);
    const connection = {
        ..._connection,
        query: async (sql, params) => await _query(_connection, sql, params),
        beginTransaction: async () => {
            let beginTransaction = util.promisify(_connection.beginTransaction).bind(_connection);
            await beginTransaction();
        },
        commit: async () => {
            if (_connection.state == 'disconnected') throw new Error('Invalid _connection');
            let commit = util.promisify(_connection.commit).bind(_connection);
            await commit();
            let end = util.promisify(_connection.end).bind(_connection);
            await end();
        },
        rollback: async () => {
            if (_connection.state == 'disconnected') return;
            let rollback = util.promisify(_connection.rollback).bind(_connection);
            await rollback();
            let end = util.promisify(_connection.end).bind(_connection);
            await end();
        },
        end: async () => {
            if (_connection.state == 'disconnected') return;
            let end = util.promisify(_connection.end).bind(_connection);
            await end();
        }
    };

    return connection;
}
module.exports.connect = connect;

/**
 * Executes the provided query.
 * @param {string} sql Sql query to execute.
 * @param {array} params Array of parameters.
 * @returns {object} the result of the query.
 */
module.exports.query = async function (sql, params) {
    if (!global.dbset) throw new Error('Not configured. Call configure() first.');
    let connection;
    try {
        // create connection
        connection = connect();

        // execute query
        const result = await connection.query(sql, params);

        // end connection
        await connection.end();

        return result;
    } catch (err) {
        if (connection) await connection.end();
        throw err;
    }
}


/**
 * Notifies MySQL that the statements that follow should be treated as a single work unit until the transaction has been ended.  
 * Returns a connection object to use with `connection.query(sql, params)` and `connection.commit()`.
 * @returns {object} Connection object.
 */
module.exports.beginTransaction = async function () {
    let connection;
    try {
        // create connection
        connection = connect();

        // begin transaction
        await connection.beginTransaction();

        return connection;
    } catch (err) {
        if (connection) await connection.end();
        throw err;
    }
}


/**
 * Helper methods
 */

/**
 * Internal query method
 * @param {*} connection 
 * @param {*} sql 
 * @param {*} params 
 */
var _query = async function (connection, sql, params) {
    if (!global.dbset) throw new Error('Not configured. Call configure() first.');
    if (!connection) throw new Error('Invalid connection.');
    try {
        // execute query
        let query = util.promisify(connection.query).bind(connection);
        const result = await query(sql, params);

        return result;
    } catch (err) {
        if (connection.state != 'disconnected' && !sql.toLowerCase().startsWith("select")) connection.rollback();
        throw err;
    }
}

function createTunnel(config) {
    return new Promise((resolve, reject) => {
        tunnel(config, (err, tunnel) => {
            if (err) return reject(err);
            return resolve(tunnel);
        });
    });
}