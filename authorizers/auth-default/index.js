const jwt = require("jsonwebtoken")

exports.handler = function (event, context, callback) {
    var token = event.authorizationToken;
    try {
        let data = jwt.verify(token.replace(/^JWT\s/, ''), process.env.JWT_SECRET, {
            clockTolerance: 60
        });
        callback(null, generatePolicy('user', 'Allow', data, event.methodArn));
    } catch (e) {
        callback(null, generatePolicy('user', 'Deny', {}, event.methodArn));
    }
};

// Help function to generate an IAM policy
var generatePolicy = function (principalId, effect, context, resource) {
    var authResponse = {};

    authResponse.principalId = principalId;
    if (effect && resource) {
        var policyDocument = {};
        policyDocument.Version = '2012-10-17';
        policyDocument.Statement = [];
        var statementOne = {};
        statementOne.Action = 'execute-api:Invoke';
        statementOne.Effect = effect;
        statementOne.Resource = resource;
        policyDocument.Statement[0] = statementOne;
        authResponse.policyDocument = policyDocument;
    }

    authResponse.context = context

    return authResponse;
}